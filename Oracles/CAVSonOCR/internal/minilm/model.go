package minilm

import (
	"bytes"
	_ "embed"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/sugarme/tokenizer"
	"github.com/sugarme/tokenizer/pretrained"
	ort "github.com/yalue/onnxruntime_go"
)

const defaultModelPath = "/usr/local/share/minilm/model.onnx"

// defaultIntraOpThreads keeps reason embedding cheap and, more importantly,
// constant per node regardless of how many oracles run inference at once.
const defaultIntraOpThreads = 1

// intraOpThreadCount reads MINILM_INTRA_OP_THREADS and falls back to
// defaultIntraOpThreads. Any non-positive or unparseable value uses the default.
func intraOpThreadCount() int {
	raw := strings.TrimSpace(os.Getenv("MINILM_INTRA_OP_THREADS"))
	if raw == "" {
		return defaultIntraOpThreads
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return defaultIntraOpThreads
	}
	return n
}

//go:embed tokenizer.json
var embeddedTokenizer []byte

type Model struct {
	tk        tokenizer.Tokenizer
	session   *ort.DynamicAdvancedSession
	modelPath string
}

type ModelOption func(*Model)

func WithRuntimePath(path string) ModelOption {
	return func(m *Model) {
		path = strings.TrimSpace(path)
		if path != "" {
			ort.SetSharedLibraryPath(path)
		}
	}
}

func WithModelPath(path string) ModelOption {
	return func(m *Model) {
		m.modelPath = strings.TrimSpace(path)
	}
}

func NewModel(opts ...ModelOption) (*Model, error) {
	model := &Model{
		modelPath: strings.TrimSpace(os.Getenv("MINILM_MODEL_PATH")),
	}
	if model.modelPath == "" {
		model.modelPath = defaultModelPath
	}

	for _, opt := range opts {
		opt(model)
	}

	tk, err := pretrained.FromReader(bytes.NewBuffer(embeddedTokenizer))
	if err != nil {
		return nil, fmt.Errorf("failed to load tokenizer: %w", err)
	}

	if _, err := os.Stat(model.modelPath); err != nil {
		return nil, fmt.Errorf("missing MiniLM model at %q: %w", model.modelPath, err)
	}

	if err := ort.InitializeEnvironment(); err != nil {
		return nil, fmt.Errorf("failed to initialize onnx runtime: %w", err)
	}

	// Pin the ONNX Runtime thread pools to a small, fixed size. With the default
	// (nil options) ORT sizes its intra-op pool to the number of physical cores,
	// so when N oracle processes run inference simultaneously (tightly packed
	// rounds in a low-latency stack) they each grab every core and oversubscribe
	// the host by ~N×. That contention — not the protocol — is what makes local
	// phases balloon under load and shrink again once network latency happens to
	// desynchronize the nodes. A fixed intra-op count makes each node's inference
	// cost independent of how synchronized the DON happens to be, which is exactly
	// what a fair benchmark needs. Override with MINILM_INTRA_OP_THREADS.
	sessionOptions, err := ort.NewSessionOptions()
	if err != nil {
		return nil, fmt.Errorf("failed to create onnx session options: %w", err)
	}
	defer sessionOptions.Destroy()
	intraOpThreads := intraOpThreadCount()
	if err := sessionOptions.SetIntraOpNumThreads(intraOpThreads); err != nil {
		return nil, fmt.Errorf("failed to set onnx intra-op threads=%d: %w", intraOpThreads, err)
	}
	if err := sessionOptions.SetInterOpNumThreads(1); err != nil {
		return nil, fmt.Errorf("failed to set onnx inter-op threads: %w", err)
	}

	inputNames := []string{"input_ids", "attention_mask", "token_type_ids"}
	outputNames := []string{"sentence_embedding"}
	session, err := ort.NewDynamicAdvancedSession(model.modelPath, inputNames, outputNames, sessionOptions)
	if err != nil {
		return nil, fmt.Errorf("failed to create session from %q: %w", model.modelPath, err)
	}

	return &Model{
		tk:        *tk,
		session:   session,
		modelPath: model.modelPath,
	}, nil
}

func (m *Model) Close() error {
	if m.session != nil {
		_ = m.session.Destroy()
	}
	return ort.DestroyEnvironment()
}

func (m *Model) Compute(sentence string, addSpecialTokens bool) ([]float32, error) {
	results, err := m.ComputeBatch([]string{sentence}, addSpecialTokens)
	if err != nil {
		return nil, err
	}
	if len(results) == 0 {
		return nil, nil
	}
	return results[0], nil
}

func (m *Model) ComputeBatch(sentences []string, addSpecialTokens bool) ([][]float32, error) {
	if len(sentences) == 0 {
		return nil, nil
	}

	inputBatch := make([]tokenizer.EncodeInput, 0, len(sentences))
	for _, s := range sentences {
		inputBatch = append(inputBatch, tokenizer.NewSingleEncodeInput(tokenizer.NewRawInputSequence(s)))
	}

	encodings, err := m.tk.EncodeBatch(inputBatch, addSpecialTokens)
	if err != nil {
		return nil, fmt.Errorf("failed to tokenize sentence: %w", err)
	}
	return m.ComputeBatchFromEncodings(encodings)
}

func (m *Model) ComputeBatchFromEncodings(encodings []tokenizer.Encoding) ([][]float32, error) {
	batchSize := len(encodings)
	seqLength := len(encodings[0].Ids)
	hiddenSize := 384

	inputShape := ort.NewShape(int64(batchSize), int64(seqLength))
	inputIdsData := make([]int64, batchSize*seqLength)
	attentionMaskData := make([]int64, batchSize*seqLength)
	tokenTypeIdsData := make([]int64, batchSize*seqLength)

	for b := range batchSize {
		for i, id := range encodings[b].Ids {
			inputIdsData[b*seqLength+i] = int64(id)
		}
		for i, mask := range encodings[b].AttentionMask {
			attentionMaskData[b*seqLength+i] = int64(mask)
		}
		for i, typeID := range encodings[b].TypeIds {
			tokenTypeIdsData[b*seqLength+i] = int64(typeID)
		}
	}

	inputIDsTensor, err := ort.NewTensor(inputShape, inputIdsData)
	if err != nil {
		return nil, fmt.Errorf("failed creating input_ids tensor: %w", err)
	}
	defer inputIDsTensor.Destroy()

	attentionMaskTensor, err := ort.NewTensor(inputShape, attentionMaskData)
	if err != nil {
		return nil, fmt.Errorf("failed creating attention_mask tensor: %w", err)
	}
	defer attentionMaskTensor.Destroy()

	tokenTypeIDsTensor, err := ort.NewTensor(inputShape, tokenTypeIdsData)
	if err != nil {
		return nil, fmt.Errorf("failed creating token_type_ids tensor: %w", err)
	}
	defer tokenTypeIDsTensor.Destroy()

	sentenceOutputShape := ort.NewShape(int64(batchSize), int64(hiddenSize))
	sentenceOutputTensor, err := ort.NewEmptyTensor[float32](sentenceOutputShape)
	if err != nil {
		return nil, fmt.Errorf("failed to create empty tensor: %w", err)
	}
	defer sentenceOutputTensor.Destroy()

	inputTensors := []ort.Value{inputIDsTensor, attentionMaskTensor, tokenTypeIDsTensor}
	outputTensors := []ort.Value{sentenceOutputTensor}

	if err := m.session.Run(inputTensors, outputTensors); err != nil {
		return nil, fmt.Errorf("failed to run session: %w", err)
	}

	flatOutput := sentenceOutputTensor.GetData()
	expectedTotalSize := batchSize * hiddenSize
	if len(flatOutput) != expectedTotalSize {
		return nil, fmt.Errorf("unexpected output tensor size: got %d elements, expected %d elements", len(flatOutput), expectedTotalSize)
	}

	results := make([][]float32, batchSize)
	for i := range batchSize {
		start := i * hiddenSize
		end := start + hiddenSize
		results[i] = make([]float32, hiddenSize)
		copy(results[i], flatOutput[start:end])
	}
	return results, nil
}
