//go:build !queue

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	minilm "cavs/cavsonocr/internal/minilm"
	noncentralizedclient "cavs/cavsonocr/oracle/noncentralized/client"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/smartcontractkit/libocr/commontypes"
	"github.com/smartcontractkit/libocr/offchainreporting2plus/ocr3types"
	"github.com/smartcontractkit/libocr/offchainreporting2plus/types"
)

type fakeReasonEmbedder struct {
	embeddings map[string][]float32
	err        error
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

type timeoutTransportError struct{}

func (timeoutTransportError) Error() string   { return "transport timed out" }
func (timeoutTransportError) Timeout() bool   { return true }
func (timeoutTransportError) Temporary() bool { return true }

func TestLoadPhaseSleepConfigValidatesBounds(t *testing.T) {
	t.Setenv("OCR_PHASE_SLEEP_OBSERVATION", "2s")
	t.Setenv("OCR_PHASE_SLEEP_ROUND_ADMISSION", "1500ms")
	cfg, err := loadPhaseSleepConfig()
	if err != nil {
		t.Fatalf("load valid phase sleeps: %v", err)
	}
	if got := cfg.duration(phaseObservation); got != 2*time.Second {
		t.Fatalf("observation sleep=%s, want 2s", got)
	}
	if got := cfg.duration(phaseRoundAdmission); got != 1500*time.Millisecond {
		t.Fatalf("round-admission sleep=%s, want 1.5s", got)
	}

	t.Setenv("OCR_PHASE_SLEEP_OBSERVATION", "31s")
	if _, err := loadPhaseSleepConfig(); err == nil {
		t.Fatal("expected sleep above the safety bound to fail")
	}
	t.Setenv("OCR_PHASE_SLEEP_OBSERVATION", "-1s")
	if _, err := loadPhaseSleepConfig(); err == nil {
		t.Fatal("expected negative sleep to fail")
	}
	t.Setenv("OCR_PHASE_SLEEP_OBSERVATION", "not-a-duration")
	if _, err := loadPhaseSleepConfig(); err == nil {
		t.Fatal("expected invalid duration to fail")
	}
}

func TestPhaseSleepIsContextAware(t *testing.T) {
	cfg := phaseSleepConfig{durations: map[string]time.Duration{phaseQuery: time.Second}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	if err := cfg.sleep(ctx, phaseQuery, nil, 7); !errors.Is(err, context.Canceled) {
		t.Fatalf("sleep error=%v, want context.Canceled", err)
	}
	if elapsed := time.Since(start); elapsed > 100*time.Millisecond {
		t.Fatalf("cancelled injected sleep took %s", elapsed)
	}
}

func TestMemDB3ConfigCopiesAndSerializesState(t *testing.T) {
	db := &memDB3{}
	original := types.ContractConfig{
		ConfigCount:   7,
		Signers:       []types.OnchainPublicKey{{1, 2, 3}},
		Transmitters:  []types.Account{"account-0"},
		OnchainConfig: []byte{4, 5},
		OffchainConfig: []byte{
			6, 7,
		},
	}
	if err := db.WriteConfig(context.Background(), original); err != nil {
		t.Fatalf("write config: %v", err)
	}

	// Mutating the caller-owned buffers after WriteConfig must not mutate the
	// database.
	original.Signers[0][0] = 99
	original.Transmitters[0] = "mutated"
	original.OnchainConfig[0] = 99
	original.OffchainConfig[0] = 99

	first, err := db.ReadConfig(context.Background())
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if first == nil {
		t.Fatal("read config returned nil")
	}
	if first.Signers[0][0] != 1 || first.Transmitters[0] != "account-0" ||
		first.OnchainConfig[0] != 4 || first.OffchainConfig[0] != 6 {
		t.Fatalf("database retained caller-owned slices: %+v", first)
	}

	// ReadConfig must likewise return an isolated snapshot.
	first.Signers[0][0] = 88
	first.OnchainConfig[0] = 88
	second, err := db.ReadConfig(context.Background())
	if err != nil {
		t.Fatalf("read second config: %v", err)
	}
	if second.Signers[0][0] != 1 || second.OnchainConfig[0] != 4 {
		t.Fatalf("read returned database-owned slices: %+v", second)
	}
}

func TestLeaderMetricPreservesSequenceNumber(t *testing.T) {
	recorder := newMetricRecorder(2, "simulation", "simulation", t.TempDir())
	recorder.recordLeader("QUERY", 42, time.Now())
	recorder.stop()
	data, err := os.ReadFile(recorder.path)
	if err != nil {
		t.Fatalf("read metric CSV: %v", err)
	}
	if !strings.Contains(string(data), ",QUERY,42,") {
		t.Fatalf("leader metric lost sequence number: %s", data)
	}
}

func TestSimulationPluginDoesNotInitializeUnusedReasonModel(t *testing.T) {
	missingModel := newMiniLMReasonEmbedder("", t.TempDir()+"/missing-model.onnx")
	factory := cavsPluginFactory{
		simulationMode: true,
		reasonEmbedder: missingModel,
	}
	plugin, _, err := factory.NewReportingPlugin(context.Background(), ocr3types.ReportingPluginConfig{N: 4})
	if err != nil {
		t.Fatalf("simulation initialized an unused reason model: %v", err)
	}
	if plugin == nil {
		t.Fatal("simulation plugin is nil")
	}
	if missingModel.model != nil || missingModel.initErr != nil {
		t.Fatal("simulation touched the MiniLM initializer")
	}

	nonSimulationModel := newMiniLMReasonEmbedder("", t.TempDir()+"/missing-model.onnx")
	factory.simulationMode = false
	factory.reasonEmbedder = nonSimulationModel
	if _, _, err := factory.NewReportingPlugin(context.Background(), ocr3types.ReportingPluginConfig{N: 4}); err == nil {
		t.Fatal("non-simulation plugin should still validate its reason model")
	}
}

func TestSimulationObservationBypassesExtractorDeterministically(t *testing.T) {
	previous := configuredPhaseSleeps
	configuredPhaseSleeps = phaseSleepConfig{}
	t.Cleanup(func() { configuredPhaseSleeps = previous })

	q := newRequestQueue()
	request := queryPayload{
		RequestID:    "request-simulation",
		OracleSetID:  "set-1",
		Statement:    "A deterministic benchmark statement",
		HolderDID:    "did:example:holder",
		AuthorSkills: []string{"(Testing, urn:test)"},
	}
	if _, _, err := q.importRequest(request); err != nil {
		t.Fatalf("import request: %v", err)
	}
	query, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("marshal query: %v", err)
	}
	p := &cavsPlugin{
		cfg:               ocr3types.ReportingPluginConfig{OracleID: 1, N: 4},
		localQueue:        q,
		requestSource:     requestSourceChain,
		skillExtractorURL: "http://must-not-be-called.invalid",
		simulationMode:    true,
	}
	got, err := p.Observation(context.Background(), ocr3types.OutcomeContext{SeqNr: 9}, types.Query(query))
	if err != nil {
		t.Fatalf("simulation observation: %v", err)
	}
	var observation observationPayload
	if err := json.Unmarshal(got, &observation); err != nil {
		t.Fatalf("decode simulation observation: %v", err)
	}
	if !observation.Competent || observation.Confidence != 0.75 {
		t.Fatalf("unexpected deterministic decision: competent=%t confidence=%v", observation.Competent, observation.Confidence)
	}
	if observation.Reason != "deterministic phase-isolation simulation" {
		t.Fatalf("unexpected simulation reason %q", observation.Reason)
	}
	if observation.RequestID != request.RequestID || observation.StatementHash != statementHashHex(request.Statement) {
		t.Fatalf("simulation observation lost request identity: %+v", observation)
	}
}

func TestObservationClaimsSelectedRequestFromFollowerQueue(t *testing.T) {
	previous := configuredPhaseSleeps
	configuredPhaseSleeps = phaseSleepConfig{}
	t.Cleanup(func() { configuredPhaseSleeps = previous })

	q := newRequestQueue()
	selected := queryPayload{
		RequestID: "selected-by-leader",
		Statement: "selected statement",
		HolderDID: "did:example:selected",
	}
	next := queryPayload{
		RequestID: "next-request",
		Statement: "next statement",
		HolderDID: "did:example:next",
	}
	for _, request := range []queryPayload{selected, next} {
		if _, _, err := q.importRequest(request); err != nil {
			t.Fatalf("import %s: %v", request.RequestID, err)
		}
	}
	query, err := json.Marshal(selected)
	if err != nil {
		t.Fatalf("marshal query: %v", err)
	}
	p := &cavsPlugin{
		cfg:        ocr3types.ReportingPluginConfig{OracleID: 1, N: 4},
		localQueue: q,
		metrics:    newMetricRecorder(1, "", "", ""),
	}
	if _, err := p.Observation(context.Background(), ocr3types.OutcomeContext{SeqNr: 9}, types.Query(query)); err != nil {
		t.Fatalf("observation: %v", err)
	}

	if _, ok := q.storedRequest(selected.RequestID); !ok {
		t.Fatal("Observation claim removed the selected request payload")
	}
	got, ok := q.currentRequest()
	if !ok || got.RequestID != selected.RequestID {
		t.Fatalf("selected request was not retained for a failed-round retry; got ok=%v request=%q", ok, got.RequestID)
	}
	q.completeRequest(selected.RequestID)
	got, ok = q.currentRequest()
	if !ok || got.RequestID != next.RequestID {
		t.Fatalf("next request got ok=%v request=%q", ok, got.RequestID)
	}
}

func TestObservationBackendFailureReturnsUnavailableEnvelope(t *testing.T) {
	previous := configuredPhaseSleeps
	configuredPhaseSleeps = phaseSleepConfig{}
	t.Cleanup(func() { configuredPhaseSleeps = previous })

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"reason":"provider unavailable"}`, http.StatusServiceUnavailable)
	}))
	defer server.Close()

	query := mustMarshalQuery(t, "backend-failure")
	p := &cavsPlugin{
		cfg:               ocr3types.ReportingPluginConfig{OracleID: 4, N: 10, F: 3},
		skillExtractorURL: server.URL,
		http:              newObservationHTTPClient(time.Second),
		metrics:           newMetricRecorder(4, "", "", ""),
		logObservations:   true,
	}
	observation, err := p.Observation(
		context.Background(),
		ocr3types.OutcomeContext{SeqNr: 12},
		query,
	)
	if err != nil {
		t.Fatalf("Observation returned a round-aborting error: %v", err)
	}
	var got observationPayload
	if err := json.Unmarshal(observation, &got); err != nil {
		t.Fatalf("decode unavailable observation: %v", err)
	}
	if got.Available == nil || *got.Available {
		t.Fatalf("backend failure was not marked unavailable: %+v", got)
	}
	if got.RequestID != "backend-failure" || got.StatementHash != statementHashHex("statement") {
		t.Fatalf("unavailable envelope lost query identity: %+v", got)
	}
}

func TestObservationQuorumCountsOnlyAvailableEnvelopes(t *testing.T) {
	p := &cavsPlugin{
		cfg: ocr3types.ReportingPluginConfig{N: 10, F: 3},
		pc:  pluginConfig{ObservationQuorumMode: quorumModeTwoFPlusOne},
	}
	query := mustMarshalQuery(t, "availability-quorum")
	observations := make([]types.AttributedObservation, 0, 8)
	for oracleID := 0; oracleID < 6; oracleID++ {
		observations = append(observations, mustMarshalObservation(t, commontypes.OracleID(oracleID), true, 0.9))
	}
	unavailable := false
	for oracleID := 6; oracleID < 8; oracleID++ {
		b, err := json.Marshal(observationPayload{
			RequestID:     "availability-quorum",
			StatementHash: statementHashHex("statement"),
			Available:     &unavailable,
			Reason:        "provider unavailable",
		})
		if err != nil {
			t.Fatalf("marshal unavailable observation: %v", err)
		}
		observations = append(observations, types.AttributedObservation{
			Observer:    commontypes.OracleID(oracleID),
			Observation: types.Observation(b),
		})
	}
	reached, err := p.ObservationQuorum(context.Background(), ocr3types.OutcomeContext{}, query, observations)
	if err != nil {
		t.Fatalf("ObservationQuorum: %v", err)
	}
	if reached {
		t.Fatal("six available plus two unavailable observations incorrectly reached a seven-observation quorum")
	}
	observations = append(observations, mustMarshalObservation(t, 8, true, 0.9))
	reached, err = p.ObservationQuorum(context.Background(), ocr3types.OutcomeContext{}, query, observations)
	if err != nil {
		t.Fatalf("ObservationQuorum after seventh available observation: %v", err)
	}
	if !reached {
		t.Fatal("seven available observations did not reach the 2f+1 quorum")
	}
}

func TestOutcomeExcludesUnavailableEnvelope(t *testing.T) {
	p := newTestPlugin()
	p.pc.TrustEnabled = false
	query := mustMarshalQuery(t, "exclude-unavailable")
	available := mustMarshalObservation(t, 0, true, 0.9)
	unavailableFlag := false
	b, err := json.Marshal(observationPayload{
		RequestID:     "exclude-unavailable",
		StatementHash: statementHashHex("statement"),
		Available:     &unavailableFlag,
		Competent:     false,
		Confidence:    1,
		Reason:        "must not become a negative vote",
	})
	if err != nil {
		t.Fatalf("marshal unavailable observation: %v", err)
	}
	out, err := p.Outcome(context.Background(), ocr3types.OutcomeContext{}, query, []types.AttributedObservation{
		available,
		{Observer: 1, Observation: types.Observation(b)},
	})
	if err != nil {
		t.Fatalf("Outcome: %v", err)
	}
	got := decodeOutcomeForTest(t, out)
	if !got.Competent || got.Reason != "reason" {
		t.Fatalf("unavailable envelope affected aggregate: %+v", got)
	}
}

func TestObservationWaitsForFollowerImportWithoutPolling(t *testing.T) {
	previous := configuredPhaseSleeps
	configuredPhaseSleeps = phaseSleepConfig{}
	t.Cleanup(func() { configuredPhaseSleeps = previous })

	q := newRequestQueue()
	request := queryPayload{
		RequestID: "query-raced-import",
		Statement: "statement",
		HolderDID: "did:example:raced",
	}
	query, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("marshal query: %v", err)
	}
	p := &cavsPlugin{
		cfg:               ocr3types.ReportingPluginConfig{OracleID: 2, N: 4},
		localQueue:        q,
		requestSource:     requestSourceChain,
		skillExtractorURL: "http://must-not-be-called.invalid",
		simulationMode:    true,
		requestImportWait: time.Second,
	}

	type observationResult struct {
		observation types.Observation
		err         error
	}
	resultCh := make(chan observationResult, 1)
	go func() {
		observation, observationErr := p.Observation(
			context.Background(),
			ocr3types.OutcomeContext{SeqNr: 11},
			types.Query(query),
		)
		resultCh <- observationResult{observation: observation, err: observationErr}
	}()

	deadline := time.Now().Add(time.Second)
	for {
		q.mu.Lock()
		waiting := len(q.waiters[request.RequestID]) == 1
		q.mu.Unlock()
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Observation did not wait for its local request import")
		}
		time.Sleep(time.Millisecond)
	}
	if _, status, err := q.importRequest(request); err != nil || status != "active" {
		t.Fatalf("late follower import status=%q err=%v", status, err)
	}

	result := <-resultCh
	if result.err != nil {
		t.Fatalf("Observation returned error: %v", result.err)
	}
	var got observationPayload
	if err := json.Unmarshal(result.observation, &got); err != nil {
		t.Fatalf("decode Observation: %v", err)
	}
	if got.RequestID != request.RequestID || !got.Competent || got.Confidence != 0.75 {
		t.Fatalf("Observation did not use late imported request: %+v", got)
	}
	if pending, ok := q.currentRequest(); !ok || pending.RequestID != request.RequestID {
		t.Fatalf("late imported claimed request was not retained for retry; got ok=%v request=%q", ok, pending.RequestID)
	}
}

func TestRedactURLForLogRemovesProviderCredentials(t *testing.T) {
	got := redactURLForLog("https://user:password@rpc.example.test:9443/v2/private-token?apiKey=also-private#fragment")
	if got != "https://rpc.example.test:9443" {
		t.Fatalf("unexpected redacted URL: %q", got)
	}
	if got := redactURLForLog("not a URL"); got != "<configured>" {
		t.Fatalf("invalid configured URL should be opaque, got %q", got)
	}
}

func TestCAVSOnchainKeyringCachesResolvedPublicKey(t *testing.T) {
	const wantAddress = "0x1111111111111111111111111111111111111111"
	resolveCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/identity/resolve" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		resolveCalls++
		var request struct {
			DID string `json:"did"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode resolve request: %v", err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":          true,
			"did":         request.DID,
			"eth_address": wantAddress,
		})
	}))
	defer server.Close()

	entry := didRegistryEntry{OracleID: 0, DID: "did:example:oracle-0"}
	keyring, account, err := newCAVSOnchainKeyring(0, server.URL, entry, []didRegistryEntry{entry})
	if err != nil {
		t.Fatalf("new keyring: %v", err)
	}
	if account != types.Account(common.HexToAddress(wantAddress).Hex()) {
		t.Fatalf("account=%q, want %q", account, common.HexToAddress(wantAddress).Hex())
	}
	if resolveCalls != 1 {
		t.Fatalf("constructor resolve calls=%d, want 1", resolveCalls)
	}

	first := keyring.PublicKey()
	if got := common.BytesToAddress(first).Hex(); got != common.HexToAddress(wantAddress).Hex() {
		t.Fatalf("public key address=%s, want %s", got, wantAddress)
	}
	first[0] ^= 0xff
	second := keyring.PublicKey()
	if got := common.BytesToAddress(second).Hex(); got != common.HexToAddress(wantAddress).Hex() {
		t.Fatalf("cached public key was exposed to mutation: %s", got)
	}
	if resolveCalls != 1 {
		t.Fatalf("PublicKey performed %d extra network resolutions", resolveCalls-1)
	}
}

func TestSetupOracleIdentityHonorsCallerCancellation(t *testing.T) {
	started := make(chan struct{})
	releaseHandler := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		select {
		case <-r.Context().Done():
		case <-releaseHandler:
		}
	}))
	defer server.Close()
	defer close(releaseHandler)

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := setupOracleIdentityViaCAVS(ctx, server.URL, 0, 5*time.Minute)
		result <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("setup request did not start")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("setup error=%v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("setup did not stop promptly after cancellation")
	}
}

func TestOracleStartupDelayIsOptInAndBounded(t *testing.T) {
	t.Setenv("OCR_ORACLE_STARTUP_STAGGER_STEP", "")
	if got, err := oracleStartupDelay(9); err != nil || got != 0 {
		t.Fatalf("default startup delay=(%s,%v), want zero", got, err)
	}

	t.Setenv("OCR_ORACLE_STARTUP_STAGGER_STEP", "250ms")
	if got, err := oracleStartupDelay(4); err != nil || got != time.Second {
		t.Fatalf("configured startup delay=(%s,%v), want 1s", got, err)
	}

	t.Setenv("OCR_ORACLE_STARTUP_STAGGER_STEP", "10s")
	if got, err := oracleStartupDelay(4); err != nil || got != maxOracleStartupStagger {
		t.Fatalf("bounded startup delay=(%s,%v), want %s", got, err, maxOracleStartupStagger)
	}

	t.Setenv("OCR_ORACLE_STARTUP_STAGGER_STEP", "-1s")
	if _, err := oracleStartupDelay(1); err == nil {
		t.Fatal("expected negative startup stagger to fail")
	}
}

func TestWaitForDIDRegistryEntriesBoundsIdentityResolution(t *testing.T) {
	registryDir := t.TempDir()
	if err := writeDIDRegistryEntry(registryDir, didRegistryEntry{
		OracleID: 0,
		DID:      "did:example:oracle-0",
	}); err != nil {
		t.Fatalf("write registry entry: %v", err)
	}
	started := make(chan struct{})
	releaseHandler := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		select {
		case <-r.Context().Done():
		case <-releaseHandler:
		}
	}))
	defer server.Close()
	defer close(releaseHandler)

	result := make(chan error, 1)
	go func() {
		_, err := waitForDIDRegistryEntries(context.Background(), server.URL, registryDir, 1, 50*time.Millisecond)
		result <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("identity resolve request did not start")
	}
	select {
	case err := <-result:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("registry wait error=%v, want context deadline", err)
		}
	case <-time.After(time.Second):
		t.Fatal("registry wait exceeded its total timeout")
	}
}

func TestWaitForDIDRegistryEntriesCachesReadyDIDResolutions(t *testing.T) {
	registryDir := t.TempDir()
	if err := writeDIDRegistryEntry(registryDir, didRegistryEntry{
		OracleID: 0,
		DID:      "did:example:oracle-0",
	}); err != nil {
		t.Fatalf("write first registry entry: %v", err)
	}

	var mu sync.Mutex
	resolveCalls := map[string]int{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			DID string `json:"did"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode resolve request: %v", err)
		}
		mu.Lock()
		resolveCalls[request.DID]++
		mu.Unlock()
		address := "0x1111111111111111111111111111111111111111"
		if strings.HasSuffix(request.DID, "1") {
			address = "0x2222222222222222222222222222222222222222"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"did":         request.DID,
			"eth_address": address,
		})
	}))
	defer server.Close()

	result := make(chan error, 1)
	go func() {
		_, err := waitForDIDRegistryEntries(context.Background(), server.URL, registryDir, 2, 2*time.Second)
		result <- err
	}()
	// Let at least one additional 500ms registry poll occur while oracle 1 is
	// absent. Oracle 0 must still be resolved only once.
	time.Sleep(650 * time.Millisecond)
	if err := writeDIDRegistryEntry(registryDir, didRegistryEntry{
		OracleID: 1,
		DID:      "did:example:oracle-1",
	}); err != nil {
		t.Fatalf("write second registry entry: %v", err)
	}
	if err := <-result; err != nil {
		t.Fatalf("wait for registry: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if resolveCalls["did:example:oracle-0"] != 1 || resolveCalls["did:example:oracle-1"] != 1 {
		t.Fatalf("unexpected resolve calls: %+v", resolveCalls)
	}
}

func TestRegisterOracleRetryBoundsInFlightCall(t *testing.T) {
	start := time.Now()
	_, err := registerOracleWithRetryFunc(context.Background(), 3, 50*time.Millisecond, func(ctx context.Context) (*noncentralizedclient.RegisterResult, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("register retry error=%v, want context deadline", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("register retry exceeded bounded timeout: %s", elapsed)
	}
}

func (f fakeReasonEmbedder) EmbedReasons(reasons []string) ([][]float32, error) {
	if f.err != nil {
		return nil, f.err
	}
	out := make([][]float32, len(reasons))
	for i, reason := range reasons {
		if emb, ok := f.embeddings[reason]; ok {
			out[i] = append([]float32(nil), emb...)
			continue
		}
		out[i] = []float32{float32(i), 0}
	}
	return out, nil
}

func signedTransmitSigs(t *testing.T, configDigest types.ConfigDigest, seqNr uint64, report types.Report) []types.AttributedOnchainSignature {
	t.Helper()
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("generate signing key: %v", err)
	}
	sig, err := crypto.Sign(reportSigHash(configDigest, seqNr, report).Bytes(), key)
	if err != nil {
		t.Fatalf("sign report: %v", err)
	}
	return []types.AttributedOnchainSignature{
		{Signature: sig, Signer: commontypes.OracleID(0)},
	}
}

func TestTransmitChainRequestStopsRetryingAfterRelayFailureThreshold(t *testing.T) {
	oIssuer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ocr/vc" {
			t.Errorf("expected relay to /ocr/vc, got %s", r.URL.Path)
		}
		http.Error(w, `{"ok":false,"error":"unknown oracle request session"}`, http.StatusNotFound)
	}))
	defer oIssuer.Close()

	reportBytes, err := json.Marshal(outcomePayload{
		RequestID:         "req-relay-failure",
		RequesterEndpoint: "http://requester.example/callback",
		Statement:         "statement",
		HolderDID:         "did:ethr:0x123",
		Competent:         true,
		Confidence:        0.8,
		Reason:            "accepted",
	})
	if err != nil {
		t.Fatalf("marshal report: %v", err)
	}

	tx := &logTransmitter{
		from:                 types.Account("0xabc"),
		oracleID:             0,
		requestSource:        requestSourceChain,
		http:                 oIssuer.Client(),
		relayFailures:        map[string]int{},
		cavsEndpointTemplate: oIssuer.URL,
	}

	for attempt := 1; attempt < maxRequesterRelayFailures; attempt++ {
		configDigest := types.ConfigDigest{}
		seqNr := uint64(attempt)
		report := types.Report(reportBytes)
		err = tx.Transmit(context.Background(), configDigest, seqNr, ocr3types.ReportWithInfo[struct{}]{
			Report: report,
			Info:   struct{}{},
		}, signedTransmitSigs(t, configDigest, seqNr, report))
		if err == nil {
			t.Fatalf("expected transmit attempt %d to still fail before threshold", attempt)
		}
	}

	configDigest := types.ConfigDigest{}
	seqNr := uint64(maxRequesterRelayFailures)
	report := types.Report(reportBytes)
	err = tx.Transmit(context.Background(), configDigest, seqNr, ocr3types.ReportWithInfo[struct{}]{
		Report: report,
		Info:   struct{}{},
	}, signedTransmitSigs(t, configDigest, seqNr, report))
	if err != nil {
		t.Fatalf("expected relay failure to become terminal after threshold, got %v", err)
	}
	if _, ok := tx.relayFailures["req-relay-failure"]; ok {
		t.Fatal("terminal relay failure counter was retained")
	}
}

func TestTransmitChainRequestWithoutRequesterEndpointIsDropped(t *testing.T) {
	reportBytes, err := json.Marshal(outcomePayload{
		RequestID:  "req-missing-endpoint",
		Statement:  "statement",
		HolderDID:  "did:ethr:0x123",
		Competent:  true,
		Confidence: 0.8,
		Reason:     "accepted",
	})
	if err != nil {
		t.Fatalf("marshal report: %v", err)
	}

	tx := &logTransmitter{
		from:          types.Account("0xabc"),
		oracleID:      0,
		requestSource: requestSourceChain,
		relayFailures: map[string]int{},
	}

	// Transmit is only ever called with an attested signature set, so pass one
	// here too: with signers present, choosing the OIssuer succeeds and the
	// missing requesterEndpoint is caught inside relayResultToOIssuer, which is
	// the branch that must drop terminally without accumulating relay failures.
	configDigest := types.ConfigDigest{}
	seqNr := uint64(1)
	report := types.Report(reportBytes)
	err = tx.Transmit(context.Background(), configDigest, seqNr, ocr3types.ReportWithInfo[struct{}]{
		Report: report,
		Info:   struct{}{},
	}, signedTransmitSigs(t, configDigest, seqNr, report))
	if err != nil {
		t.Fatalf("expected missing requester endpoint to be dropped terminally, got %v", err)
	}
	if got := tx.relayFailures["req-missing-endpoint"]; got != 0 {
		t.Fatalf("expected no relay failure retries to accumulate, got %d", got)
	}
}

func newTestPlugin() *cavsPlugin {
	pc := pluginConfig{
		TrustEnabled:             true,
		TrustDeltaBps:            10,
		TrustedBeliefMinBps:      51,
		TrustedUncertaintyMaxBps: 49,
	}
	pc.normalize()
	return &cavsPlugin{
		cfg:            ocr3types.ReportingPluginConfig{N: 4},
		pc:             pc,
		trustDIDs:      []string{"did:oracle:0", "did:oracle:1", "did:oracle:2", "did:oracle:3"},
		reasonEmbedder: fakeReasonEmbedder{},
	}
}

func TestOutcomeOmitsTrustWhenDisabled(t *testing.T) {
	p := newTestPlugin()
	p.pc.TrustEnabled = false

	out, err := p.Outcome(context.Background(), ocr3types.OutcomeContext{}, mustMarshalQuery(t, "req-no-trust"), []types.AttributedObservation{
		mustMarshalObservation(t, 0, true, 0.90),
		mustMarshalObservation(t, 1, false, 0.95),
		mustMarshalObservation(t, 2, false, 0.80),
	})
	if err != nil {
		t.Fatalf("Outcome returned error: %v", err)
	}

	var got outcomePayload
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("unmarshal outcome: %v", err)
	}
	if got.Trust != nil {
		t.Fatalf("expected trust payload to be omitted when trust is disabled")
	}
	if got.Competent {
		t.Fatalf("expected unweighted majority to determine competence when trust is disabled")
	}
}

func TestValidateObservationRejectsDifferentRequestID(t *testing.T) {
	p := newTestPlugin()
	query := mustMarshalQuery(t, "req-a")
	obsBytes, err := json.Marshal(observationPayload{
		RequestID:     "req-b",
		StatementHash: statementHashHex("statement"),
		Competent:     true,
		Confidence:    0.9,
	})
	if err != nil {
		t.Fatalf("marshal observation: %v", err)
	}
	err = p.ValidateObservation(context.Background(), ocr3types.OutcomeContext{}, query, types.AttributedObservation{
		Observer:    0,
		Observation: types.Observation(obsBytes),
	})
	if err == nil || !strings.Contains(err.Error(), "requestID mismatch") {
		t.Fatalf("expected requestID mismatch, got %v", err)
	}
}

func TestOutcomeDoesNotAggregateDifferentRequestIDs(t *testing.T) {
	p := newTestPlugin()
	p.pc.TrustEnabled = false
	query := mustMarshalQuery(t, "req-a")
	good := mustMarshalObservation(t, 0, true, 0.9)
	badBytes, err := json.Marshal(observationPayload{
		RequestID:     "req-b",
		StatementHash: statementHashHex("statement"),
		Competent:     false,
		Confidence:    1.0,
		Reason:        "wrong request",
	})
	if err != nil {
		t.Fatalf("marshal bad observation: %v", err)
	}
	out, err := p.Outcome(context.Background(), ocr3types.OutcomeContext{}, query, []types.AttributedObservation{
		good,
		{Observer: 1, Observation: types.Observation(badBytes)},
	})
	if err != nil {
		t.Fatalf("Outcome returned error: %v", err)
	}
	got := decodeOutcomeForTest(t, out)
	if !got.Competent || got.Reason != "reason" {
		t.Fatalf("expected only matching request observation to aggregate, got %+v", got)
	}
}

func TestOutcomeRetiresRequestBeforeAttestation(t *testing.T) {
	q := newRequestQueue()
	current := queryPayload{
		RequestID:     "agreed-request",
		Statement:     "statement",
		StatementHash: statementHashHex("statement"),
		HolderDID:     "did:ethr:0x123",
	}
	next := queryPayload{
		RequestID:     "next-request",
		Statement:     "next statement",
		StatementHash: statementHashHex("next statement"),
		HolderDID:     "did:ethr:0x456",
	}
	for _, request := range []queryPayload{current, next} {
		if _, _, err := q.importRequest(request); err != nil {
			t.Fatalf("import %s: %v", request.RequestID, err)
		}
	}
	selected, ok := q.currentRequest()
	if !ok || selected.RequestID != current.RequestID {
		t.Fatalf("selected request got ok=%v request=%q", ok, selected.RequestID)
	}

	p := newTestPlugin()
	p.localQueue = q
	query := mustMarshalQuery(t, current.RequestID)
	observations := []types.AttributedObservation{
		mustMarshalObservation(t, 0, true, 0.9),
		mustMarshalObservation(t, 1, true, 0.8),
		mustMarshalObservation(t, 2, true, 0.7),
	}
	if _, err := p.Outcome(
		context.Background(),
		ocr3types.OutcomeContext{SeqNr: 9},
		query,
		observations,
	); err != nil {
		t.Fatalf("Outcome returned error: %v", err)
	}

	selected, ok = q.currentRequest()
	if !ok || selected.RequestID != next.RequestID {
		t.Fatalf(
			"request was not retired at Outcome; next got ok=%v request=%q",
			ok,
			selected.RequestID,
		)
	}
}

var lastTestRequestID string

func mustMarshalQuery(t *testing.T, requestID string) types.Query {
	t.Helper()
	lastTestRequestID = requestID
	b, err := json.Marshal(queryPayload{
		RequestID:     requestID,
		Statement:     "statement",
		StatementHash: statementHashHex("statement"),
		HolderDID:     "did:ethr:0x123",
	})
	if err != nil {
		t.Fatalf("marshal query: %v", err)
	}
	return types.Query(b)
}

func mustMarshalObservation(t *testing.T, observer commontypes.OracleID, comp bool, conf float64) types.AttributedObservation {
	t.Helper()
	return mustMarshalObservationWithReason(t, observer, comp, conf, "reason")
}

func mustMarshalObservationWithReason(t *testing.T, observer commontypes.OracleID, comp bool, conf float64, reason string) types.AttributedObservation {
	t.Helper()
	b, err := json.Marshal(observationPayload{
		RequestID:     lastTestRequestID,
		StatementHash: statementHashHex("statement"),
		Competent:     comp,
		Confidence:    conf,
		Reason:        reason,
	})
	if err != nil {
		t.Fatalf("marshal observation: %v", err)
	}
	return types.AttributedObservation{
		Observer:    observer,
		Observation: types.Observation(b),
	}
}

func mustMarshalPreviousOutcome(t *testing.T, trust *trustPayload) ocr3types.Outcome {
	t.Helper()
	b, err := json.Marshal(outcomePayload{Trust: trust})
	if err != nil {
		t.Fatalf("marshal previous outcome: %v", err)
	}
	return ocr3types.Outcome(b)
}

func decodeOutcomeForTest(t *testing.T, out ocr3types.Outcome) outcomePayload {
	t.Helper()
	var got outcomePayload
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("decode outcome: %v", err)
	}
	return got
}

func TestOutcomeFalseConsensusUsesDecisionAlignedAggregateScore(t *testing.T) {
	p := newTestPlugin()
	query := mustMarshalQuery(t, "req-false")
	obs := []types.AttributedObservation{
		mustMarshalObservation(t, 0, false, 0.9),
		mustMarshalObservation(t, 1, false, 0.9),
		mustMarshalObservation(t, 2, false, 0.9),
	}

	out, err := p.Outcome(context.Background(), ocr3types.OutcomeContext{SeqNr: 1}, query, obs)
	if err != nil {
		t.Fatalf("Outcome returned error: %v", err)
	}
	got := decodeOutcomeForTest(t, out)

	if got.Competent {
		t.Fatalf("expected aggregate competence=false, got true")
	}
	if got.Trust == nil {
		t.Fatalf("expected trust payload in outcome")
	}
	if got.Trust.Running[0].B != 100 || got.Trust.Running[0].D != 0 || got.Trust.Running[0].U != 0 {
		t.Fatalf("expected positive trust update for honest false observation, got %+v", got.Trust.Running[0])
	}
}

func TestOutcomeZeroWeightOraclesDoNotInfluenceConfidenceAggregation(t *testing.T) {
	p := newTestPlugin()
	query := mustMarshalQuery(t, "req-zero-weight")
	prevTrust := &trustPayload{
		EpochLen: 1,
		Epoch:    1,
		Running: []trustOpinionBps{
			{B: 0, D: 100, U: 0},
			{B: 0, D: 98, U: 2},
			{B: 0, D: 98, U: 2},
			{B: 0, D: 98, U: 2},
		},
		Pending: initTrustEvidence(4),
	}
	prev := mustMarshalPreviousOutcome(t, prevTrust)
	obs := []types.AttributedObservation{
		mustMarshalObservation(t, 0, true, 1.0),
		mustMarshalObservation(t, 1, true, 0.2),
		mustMarshalObservation(t, 2, true, 0.8),
	}

	out, err := p.Outcome(context.Background(), ocr3types.OutcomeContext{
		SeqNr:           2,
		PreviousOutcome: prev,
	}, query, obs)
	if err != nil {
		t.Fatalf("Outcome returned error: %v", err)
	}
	got := decodeOutcomeForTest(t, out)

	if !got.Competent {
		t.Fatalf("expected aggregate competence=true, got false")
	}
	if math.Abs(got.Confidence-0.5) > 1e-9 {
		t.Fatalf("expected zero-weight oracle to be excluded from weighted median, got confidence=%v", got.Confidence)
	}
}

func TestOutcomeConfidenceAndReasonUseAggregateCompetenceSubset(t *testing.T) {
	p := newTestPlugin()
	query := mustMarshalQuery(t, "req-aligned-subset")
	obs := []types.AttributedObservation{
		mustMarshalObservationWithReason(t, 0, true, 0.2, "aligned-low"),
		mustMarshalObservationWithReason(t, 1, true, 0.8, "aligned-high"),
		mustMarshalObservationWithReason(t, 2, false, 1.0, "misaligned"),
	}

	out, err := p.Outcome(context.Background(), ocr3types.OutcomeContext{SeqNr: 1}, query, obs)
	if err != nil {
		t.Fatalf("Outcome returned error: %v", err)
	}
	got := decodeOutcomeForTest(t, out)

	if !got.Competent {
		t.Fatalf("expected aggregate competence=true, got false")
	}
	if math.Abs(got.Confidence-0.5) > 1e-9 {
		t.Fatalf("expected confidence to use only competence-aligned observations, got %v", got.Confidence)
	}
	if got.Reason != "aligned-low" {
		t.Fatalf("expected reason from median competence-aligned text embedding, got %q", got.Reason)
	}
}

func TestOutcomeConfidenceUsesMedianNotAverage(t *testing.T) {
	p := newTestPlugin()
	query := mustMarshalQuery(t, "req-median-confidence")
	obs := []types.AttributedObservation{
		mustMarshalObservationWithReason(t, 0, true, 0.1, "low"),
		mustMarshalObservationWithReason(t, 1, true, 0.1, "low-again"),
		mustMarshalObservationWithReason(t, 2, true, 1.0, "high"),
	}

	out, err := p.Outcome(context.Background(), ocr3types.OutcomeContext{SeqNr: 1}, query, obs)
	if err != nil {
		t.Fatalf("Outcome returned error: %v", err)
	}
	got := decodeOutcomeForTest(t, out)

	if !got.Competent {
		t.Fatalf("expected aggregate competence=true, got false")
	}
	if math.Abs(got.Confidence-0.1) > 1e-9 {
		t.Fatalf("expected confidence median 0.1, got %v", got.Confidence)
	}
}

func TestOutcomeReasonUsesMedianTextEmbedding(t *testing.T) {
	p := newTestPlugin()
	p.reasonEmbedder = fakeReasonEmbedder{embeddings: map[string][]float32{
		"medical expertise supports this assessment": {0, 0},
		"medical expertise is present":               {0.1, 0},
		"unrelated finance background":               {10, 10},
	}}
	query := mustMarshalQuery(t, "req-median-reason")
	obs := []types.AttributedObservation{
		mustMarshalObservationWithReason(t, 0, true, 0.2, "medical expertise supports this assessment"),
		mustMarshalObservationWithReason(t, 1, true, 0.9, "medical expertise is present"),
		mustMarshalObservationWithReason(t, 2, true, 1.0, "unrelated finance background"),
	}

	out, err := p.Outcome(context.Background(), ocr3types.OutcomeContext{SeqNr: 1}, query, obs)
	if err != nil {
		t.Fatalf("Outcome returned error: %v", err)
	}
	got := decodeOutcomeForTest(t, out)

	if got.Reason != "medical expertise supports this assessment" && got.Reason != "medical expertise is present" {
		t.Fatalf("expected reason from the median medical explanation cluster, got %q", got.Reason)
	}
}

func TestOutcomeReasonEmbeddingTieBreaksByOracleID(t *testing.T) {
	p := newTestPlugin()
	p.reasonEmbedder = fakeReasonEmbedder{embeddings: map[string][]float32{
		"first":  {-1, 0},
		"second": {1, 0},
	}}
	query := mustMarshalQuery(t, "req-reason-tie")
	obs := []types.AttributedObservation{
		mustMarshalObservationWithReason(t, 2, true, 0.7, "second"),
		mustMarshalObservationWithReason(t, 1, true, 0.7, "first"),
	}

	out, err := p.Outcome(context.Background(), ocr3types.OutcomeContext{SeqNr: 1}, query, obs)
	if err != nil {
		t.Fatalf("Outcome returned error: %v", err)
	}
	got := decodeOutcomeForTest(t, out)

	if got.Reason != "first" {
		t.Fatalf("expected reason tie to break by oracle id, got %q", got.Reason)
	}
}

func TestOutcomeReasonEmbeddingErrorFallsBackToConfidenceMedianReason(t *testing.T) {
	p := newTestPlugin()
	p.reasonEmbedder = fakeReasonEmbedder{err: errors.New("embedder down")}
	query := mustMarshalQuery(t, "req-reason-error")
	obs := []types.AttributedObservation{
		mustMarshalObservationWithReason(t, 0, true, 0.7, "first"),
		mustMarshalObservationWithReason(t, 1, true, 0.7, "second"),
	}

	out, err := p.Outcome(context.Background(), ocr3types.OutcomeContext{SeqNr: 1}, query, obs)
	if err != nil {
		t.Fatalf("expected fallback reason, got error %v", err)
	}
	got := decodeOutcomeForTest(t, out)
	if got.Reason != "first" {
		t.Fatalf("expected fallback reason to pick lowest-oracle confidence-median reason, got %q", got.Reason)
	}
}

func TestMiniLMReasonEmbedderIntegration(t *testing.T) {
	if os.Getenv("CAVS_MINILM_INTEGRATION") != "1" {
		t.Skip("set CAVS_MINILM_INTEGRATION=1 to load ONNX Runtime and the real MiniLM model")
	}
	runtimePath := os.Getenv("ONNXRUNTIME_LIB_PATH")
	if runtimePath == "" {
		runtimePath = defaultONNXRuntimePath
	}
	model, err := minilm.NewModel(
		minilm.WithRuntimePath(runtimePath),
		minilm.WithModelPath(defaultMiniLMModelPath),
	)
	if err != nil {
		t.Fatalf("NewModel: %v", err)
	}
	defer func() { _ = model.Close() }()

	embeddings, err := model.ComputeBatch([]string{"one reason", "another reason", "third reason"}, false)
	if err != nil {
		t.Fatalf("ComputeBatch: %v", err)
	}
	if len(embeddings) != 3 {
		t.Fatalf("expected three embeddings, got %d", len(embeddings))
	}
	for i, emb := range embeddings {
		if len(emb) != 384 {
			t.Fatalf("embedding %d dimensions: got %d, want 384", i, len(emb))
		}
	}
}

func TestOutcomeTrustUpdatesEveryRequest(t *testing.T) {
	p := newTestPlugin()
	query := mustMarshalQuery(t, "req-1")
	obs := []types.AttributedObservation{
		mustMarshalObservation(t, 0, true, 0.9),
		mustMarshalObservation(t, 1, true, 0.9),
		mustMarshalObservation(t, 2, true, 0.9),
	}

	out, err := p.Outcome(context.Background(), ocr3types.OutcomeContext{SeqNr: 1}, query, obs)
	if err != nil {
		t.Fatalf("Outcome returned error: %v", err)
	}
	got := decodeOutcomeForTest(t, out)
	if got.Trust == nil {
		t.Fatalf("expected trust payload after outcome")
	}
	if got.Trust.Epoch != 2 {
		t.Fatalf("expected epoch to advance after every request, got %d", got.Trust.Epoch)
	}
	if got.Trust.RequestsInEpoch != 0 {
		t.Fatalf("expected epoch progress reset after update, got %d", got.Trust.RequestsInEpoch)
	}
	if got.Trust.Pending[0].Pos != 0 || got.Trust.Pending[0].Neg != 0 || got.Trust.Pending[0].Unc != 0 {
		t.Fatalf("expected pending evidence reset after update, got %+v", got.Trust.Pending[0])
	}
	if got.Trust.Running[0].B != 100 || got.Trust.Running[0].D != 0 || got.Trust.Running[0].U != 0 {
		t.Fatalf("expected running trust update after request, got %+v", got.Trust.Running[0])
	}
}

func TestOutcomeUsesEveryValidObservation(t *testing.T) {
	p := newTestPlugin()
	query := mustMarshalQuery(t, "req-all-observations")

	firstBytes, err := json.Marshal(observationPayload{
		RequestID:     "req-all-observations",
		StatementHash: statementHashHex("statement"),
		Competent:     true,
		Confidence:    1.0,
		Reason:        "included",
	})
	if err != nil {
		t.Fatalf("marshal first observation: %v", err)
	}
	obs := []types.AttributedObservation{
		{
			Observer:    0,
			Observation: types.Observation(firstBytes),
		},
		mustMarshalObservationWithReason(t, 1, true, 0.3, "selected"),
		mustMarshalObservationWithReason(t, 2, true, 0.7, "selected-high"),
	}

	out, err := p.Outcome(context.Background(), ocr3types.OutcomeContext{SeqNr: 1}, query, obs)
	if err != nil {
		t.Fatalf("Outcome returned error: %v", err)
	}
	got := decodeOutcomeForTest(t, out)

	if !got.Competent {
		t.Fatalf("expected aggregate competence=true, got false")
	}
	if math.Abs(got.Confidence-0.7) > 1e-9 {
		t.Fatalf("expected every valid observation to be included, got confidence=%v", got.Confidence)
	}
}

func TestHashDirectRequestIgnoresAuthorSkillOrder(t *testing.T) {
	first := hashDirectRequest(
		"http://requester.example/results",
		"statement",
		"did:ethr:0x123",
		[]string{"(B, uri:b)", "(A, uri:a)"},
	)
	second := hashDirectRequest(
		"http://requester.example/results",
		"statement",
		"did:ethr:0x123",
		[]string{"(A, uri:a)", "(B, uri:b)"},
	)

	if first == "" || second == "" {
		t.Fatalf("expected non-empty request ids")
	}
	if first != second {
		t.Fatalf("expected identical hashes for reordered author skills, got %q vs %q", first, second)
	}
}

func TestHashDirectRequestWithPresentationUsesPresentation(t *testing.T) {
	first := hashDirectRequestWithPresentation(
		"http://requester.example/results",
		"statement",
		"did:ethr:0x123",
		json.RawMessage(`{"holder":"did:ethr:0x123","id":"vp-1"}`),
	)
	second := hashDirectRequestWithPresentation(
		"http://requester.example/results",
		"statement",
		"did:ethr:0x123",
		json.RawMessage(`{"id":"vp-2","holder":"did:ethr:0x123"}`),
	)

	if first == "" || second == "" {
		t.Fatalf("expected non-empty request ids")
	}
	if first == second {
		t.Fatalf("expected different hashes for different holder presentations")
	}
}

func TestObservationForwardsPresentationToLocalCAVS(t *testing.T) {
	var got map[string]any
	extractor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/extract" {
			t.Fatalf("unexpected extractor request %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatalf("decode extractor request: %v", err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"competent":    true,
			"confidence":   0.75,
			"reason":       "verified",
			"authorSkills": []any{map[string]any{"label": "A", "uri": "uri:a"}},
		})
	}))
	defer extractor.Close()

	p := newTestPlugin()
	p.skillExtractorURL = extractor.URL
	p.http = extractor.Client()

	queryBytes, err := json.Marshal(queryPayload{
		RequestID:         "request-with-vp",
		RequesterEndpoint: "http://requester.example/results",
		Statement:         "statement",
		HolderDID:         "did:ethr:0x123",
		Presentation:      json.RawMessage(`{"holder":"did:ethr:0x123","id":"vp-1"}`),
	})
	if err != nil {
		t.Fatalf("marshal query: %v", err)
	}

	obs, err := p.Observation(context.Background(), ocr3types.OutcomeContext{SeqNr: 9}, types.Query(queryBytes))
	if err != nil {
		t.Fatalf("Observation returned error: %v", err)
	}

	if got["authorSkills"] != nil {
		t.Fatalf("expected oracle not to forward trusted authorSkills, got %+v", got["authorSkills"])
	}
	if got["presentation"] == nil {
		t.Fatalf("expected oracle to forward holder presentation")
	}

	var decoded observationPayload
	if err := json.Unmarshal(obs, &decoded); err != nil {
		t.Fatalf("decode observation: %v", err)
	}
	if !decoded.Competent || decoded.Confidence != 0.75 || decoded.Reason != "verified" {
		t.Fatalf("unexpected observation: %+v", decoded)
	}
	if len(decoded.AuthorSkills) != 1 || decoded.AuthorSkills[0] != "(A, uri:a)" {
		t.Fatalf("expected normalized verified author skills, got %+v", decoded.AuthorSkills)
	}
}

func TestObservationRetriesRetryablePreResponseFailureWithStableIdentity(t *testing.T) {
	type requestSnapshot struct {
		body           []byte
		idempotencyKey string
		requestID      string
		close          bool
		hasGetBody     bool
	}

	var snapshots []requestSnapshot
	transport := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		body, err := io.ReadAll(req.Body)
		if err != nil {
			t.Fatalf("read extraction request body: %v", err)
		}
		snapshots = append(snapshots, requestSnapshot{
			body:           body,
			idempotencyKey: req.Header.Get(observationIdempotencyHeader),
			requestID:      req.Header.Get(observationRequestIdentityHeader),
			close:          req.Close,
			hasGetBody:     req.GetBody != nil,
		})
		if len(snapshots) == 1 {
			return nil, fmt.Errorf("write extraction request: %w", syscall.EPIPE)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Status:     "200 OK",
			Header:     make(http.Header),
			Body: io.NopCloser(strings.NewReader(
				`{"competent":true,"confidence":0.75,"reason":"verified"}`,
			)),
			Request: req,
		}, nil
	})

	p := newTestPlugin()
	p.cfg.OracleID = 2
	p.skillExtractorURL = "http://extractor.invalid"
	p.http = &http.Client{Transport: transport}

	queryBytes, err := json.Marshal(queryPayload{
		RequestID: "request-retried-once",
		Statement: "statement",
		HolderDID: "did:ethr:0x123",
	})
	if err != nil {
		t.Fatalf("marshal query: %v", err)
	}

	observation, err := p.Observation(
		context.Background(),
		ocr3types.OutcomeContext{SeqNr: 17},
		types.Query(queryBytes),
	)
	if err != nil {
		t.Fatalf("Observation returned error: %v", err)
	}
	if len(snapshots) != observationHTTPMaxAttempts {
		t.Fatalf("transport attempts=%d, want %d", len(snapshots), observationHTTPMaxAttempts)
	}
	if !bytes.Equal(snapshots[0].body, snapshots[1].body) {
		t.Fatalf("retry body changed:\nfirst=%s\nsecond=%s", snapshots[0].body, snapshots[1].body)
	}
	if snapshots[0].idempotencyKey == "" ||
		snapshots[0].idempotencyKey != snapshots[1].idempotencyKey {
		t.Fatalf("idempotency keys are not stable and non-empty: %+v", snapshots)
	}
	for attempt, snapshot := range snapshots {
		if snapshot.requestID != "request-retried-once" {
			t.Fatalf("attempt %d request identity=%q", attempt+1, snapshot.requestID)
		}
		if snapshot.hasGetBody {
			t.Fatalf("attempt %d exposes GetBody, allowing hidden net/http replay", attempt+1)
		}
	}
	if snapshots[0].close {
		t.Fatal("first attempt unexpectedly forced Connection: close")
	}
	if !snapshots[1].close {
		t.Fatal("retry did not force a fresh connection")
	}

	var decoded observationPayload
	if err := json.Unmarshal(observation, &decoded); err != nil {
		t.Fatalf("decode observation: %v", err)
	}
	if !decoded.Competent || decoded.Confidence != 0.75 || decoded.Reason != "verified" {
		t.Fatalf("unexpected observation: %+v", decoded)
	}
}

func TestObservationTimeoutStaysAliveThroughResponseBody(t *testing.T) {
	extractor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		// Ensure Client.Do returns on the flushed headers while the JSON body is
		// still pending. The observation timeout must remain alive for this read.
		time.Sleep(50 * time.Millisecond)
		_, _ = io.WriteString(
			w,
			`{"competent":true,"confidence":0.75,"reason":"delayed body"}`,
		)
	}))
	defer extractor.Close()

	p := newTestPlugin()
	p.cfg.OracleID = 2
	p.skillExtractorURL = extractor.URL
	p.http = extractor.Client()
	p.observationTimeout = time.Second

	queryBytes, err := json.Marshal(queryPayload{
		RequestID: "request-with-delayed-body",
		Statement: "statement",
		HolderDID: "did:ethr:0x123",
	})
	if err != nil {
		t.Fatalf("marshal query: %v", err)
	}

	observation, err := p.Observation(
		context.Background(),
		ocr3types.OutcomeContext{SeqNr: 18},
		types.Query(queryBytes),
	)
	if err != nil {
		t.Fatalf("Observation returned error: %v", err)
	}
	var decoded observationPayload
	if err := json.Unmarshal(observation, &decoded); err != nil {
		t.Fatalf("decode observation: %v", err)
	}
	if !observationAvailable(decoded) {
		t.Fatalf("delayed response body was canceled: %+v", decoded)
	}
	if !decoded.Competent || decoded.Confidence != 0.75 || decoded.Reason != "delayed body" {
		t.Fatalf("unexpected observation: %+v", decoded)
	}
}

func TestObservationHTTPClientPinsConnectionAndRedirectPolicy(t *testing.T) {
	client := newObservationHTTPClient(17 * time.Second)
	if client.Timeout != 17*time.Second {
		t.Fatalf("client timeout=%s, want 17s", client.Timeout)
	}
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport type=%T, want *http.Transport", client.Transport)
	}
	if transport.IdleConnTimeout != observationHTTPIdleConnTimeout {
		t.Fatalf(
			"idle connection timeout=%s, want %s",
			transport.IdleConnTimeout,
			observationHTTPIdleConnTimeout,
		)
	}
	if transport.ForceAttemptHTTP2 {
		t.Fatal("extractor transport unexpectedly enables HTTP/2")
	}
	if transport.Protocols == nil ||
		!transport.Protocols.HTTP1() ||
		transport.Protocols.HTTP2() ||
		transport.Protocols.UnencryptedHTTP2() {
		t.Fatalf("extractor protocols=%v, want HTTP/1 only", transport.Protocols)
	}
	if client.CheckRedirect == nil {
		t.Fatal("extractor client has no redirect policy")
	}
	request, err := http.NewRequest(http.MethodPost, "http://extractor.invalid/extract", nil)
	if err != nil {
		t.Fatalf("create request: %v", err)
	}
	if err := client.CheckRedirect(request, nil); !errors.Is(err, http.ErrUseLastResponse) {
		t.Fatalf("redirect policy error=%v, want http.ErrUseLastResponse", err)
	}
}

func TestObservationHTTPClientUsesHTTP1AgainstHTTP2CapableServer(t *testing.T) {
	protocolMajor := make(chan int, 1)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		protocolMajor <- req.ProtoMajor
		w.WriteHeader(http.StatusNoContent)
	}))
	server.EnableHTTP2 = true
	server.StartTLS()
	defer server.Close()

	client := newObservationHTTPClient(5 * time.Second)
	defer client.CloseIdleConnections()
	transport := client.Transport.(*http.Transport)
	serverTransport := server.Client().Transport.(*http.Transport)
	transport.TLSClientConfig = serverTransport.TLSClientConfig.Clone()

	resp, err := client.Get(server.URL)
	if err != nil {
		t.Fatalf("HTTP/1-only request to HTTP/2-capable server: %v", err)
	}
	_ = resp.Body.Close()
	if got := <-protocolMajor; got != 1 {
		t.Fatalf("request protocol major=%d, want HTTP/1", got)
	}
}

func TestObservationRetryIsBoundedAtTwoAttempts(t *testing.T) {
	var attempts int
	p := newTestPlugin()
	p.skillExtractorURL = "http://extractor.invalid"
	p.http = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		attempts++
		return nil, fmt.Errorf("read extraction response: %w", syscall.ECONNRESET)
	})}

	queryBytes, err := json.Marshal(queryPayload{
		RequestID: "request-reset-twice",
		Statement: "statement",
		HolderDID: "did:ethr:0x123",
	})
	if err != nil {
		t.Fatalf("marshal query: %v", err)
	}
	observation, err := p.Observation(
		context.Background(),
		ocr3types.OutcomeContext{SeqNr: 19},
		types.Query(queryBytes),
	)
	if err != nil {
		t.Fatalf("retry exhaustion aborted the OCR round: %v", err)
	}
	var got observationPayload
	if err := json.Unmarshal(observation, &got); err != nil {
		t.Fatalf("decode unavailable observation: %v", err)
	}
	if got.Available == nil || *got.Available {
		t.Fatalf("retry exhaustion was not marked unavailable: %+v", got)
	}
	if attempts != observationHTTPMaxAttempts {
		t.Fatalf("transport attempts=%d, want exactly %d", attempts, observationHTTPMaxAttempts)
	}
}

func TestObservationDoesNotRetryTimeoutOrHTTPFailure(t *testing.T) {
	tests := []struct {
		name          string
		transport     roundTripFunc
		wantAvailable bool
	}{
		{
			name:          "transport timeout",
			wantAvailable: true,
			transport: func(*http.Request) (*http.Response, error) {
				return nil, timeoutTransportError{}
			},
		},
		{
			name:          "provider HTTP timeout",
			wantAvailable: true,
			transport: func(req *http.Request) (*http.Response, error) {
				return &http.Response{
					StatusCode: http.StatusGatewayTimeout,
					Status:     "504 Gateway Timeout",
					Header:     make(http.Header),
					Body:       io.NopCloser(strings.NewReader(`{"error":"provider timeout"}`)),
					Request:    req,
				}, nil
			},
		},
		{
			name:          "non-timeout HTTP failure",
			wantAvailable: false,
			transport: func(req *http.Request) (*http.Response, error) {
				return &http.Response{
					StatusCode: http.StatusServiceUnavailable,
					Status:     "503 Service Unavailable",
					Header:     make(http.Header),
					Body:       io.NopCloser(strings.NewReader(`{"error":"provider unavailable"}`)),
					Request:    req,
				}, nil
			},
		},
		{
			name:          "provider timeout encoded in HTTP 503",
			wantAvailable: true,
			transport: func(req *http.Request) (*http.Response, error) {
				return &http.Response{
					StatusCode: http.StatusServiceUnavailable,
					Status:     "503 Service Unavailable",
					Header:     make(http.Header),
					Body:       io.NopCloser(strings.NewReader(`{"error":"gemma competence checker timed out"}`)),
					Request:    req,
				}, nil
			},
		},
		{
			name:          "provider timeout nested in HTTP 503",
			wantAvailable: true,
			transport: func(req *http.Request) (*http.Response, error) {
				return &http.Response{
					StatusCode: http.StatusServiceUnavailable,
					Status:     "503 Service Unavailable",
					Header:     make(http.Header),
					Body: io.NopCloser(strings.NewReader(
						`{"error":"azure-openai competence checker request failed","detail":{"detail":"OpenAI connection error: Request timed out."}}`,
					)),
					Request: req,
				}, nil
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var attempts int
			p := newTestPlugin()
			p.skillExtractorURL = "http://extractor.invalid"
			p.http = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				attempts++
				return test.transport(req)
			})}

			queryBytes, err := json.Marshal(queryPayload{
				RequestID: "request-not-retried",
				Statement: "statement",
				HolderDID: "did:ethr:0x123",
			})
			if err != nil {
				t.Fatalf("marshal query: %v", err)
			}
			observation, err := p.Observation(
				context.Background(),
				ocr3types.OutcomeContext{SeqNr: 23},
				types.Query(queryBytes),
			)
			if err != nil {
				t.Fatalf("backend failure aborted the OCR round: %v", err)
			}
			var got observationPayload
			if err := json.Unmarshal(observation, &got); err != nil {
				t.Fatalf("decode unavailable observation: %v", err)
			}
			if observationAvailable(got) != test.wantAvailable {
				t.Fatalf("observation availability=%t, want %t: %+v", observationAvailable(got), test.wantAvailable, got)
			}
			if test.wantAvailable && (got.Competent || got.Confidence != 0) {
				t.Fatalf("timeout fallback was not a zero-confidence negative vote: %+v", got)
			}
			if test.wantAvailable && !strings.Contains(got.Reason, "inconclusive analysis") {
				t.Fatalf("timeout fallback reason does not identify inconclusive analysis: %+v", got)
			}
			if attempts != 1 {
				t.Fatalf("transport attempts=%d, want 1", attempts)
			}
		})
	}
}

func TestObservationModelCallTimeoutReservesFallbackTime(t *testing.T) {
	ctx := context.Background()
	if got := observationModelCallTimeout(ctx, 120*time.Second); got != 8*time.Second {
		t.Fatalf("model timeout=%s, want 8s", got)
	}
	if got := observationModelCallTimeout(ctx, time.Second); got != 900*time.Millisecond {
		t.Fatalf("short model timeout=%s, want 900ms", got)
	}
	if got := observationModelCallTimeout(ctx, 300*time.Second); got != 8*time.Second {
		t.Fatalf("long-phase model timeout=%s, want 8s", got)
	}
	if got := observationModelCallTimeout(ctx, 0); got != 8*time.Second {
		t.Fatalf("default model timeout=%s, want 8s", got)
	}
}

func TestObservationModelCallTimeoutUsesRemainingContextBudget(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	got := observationModelCallTimeout(ctx, 20*time.Second)
	// Ten percent of the remaining context budget is reserved for encoding and
	// returning the timeout vote. Scheduler jitter makes the exact nanoseconds
	// nondeterministic, so assert a narrow safe interval around 1.8s.
	if got < 1700*time.Millisecond || got > 1850*time.Millisecond {
		t.Fatalf("deadline-aware model timeout=%s, want about 1.8s", got)
	}
}

func TestObservationRetryRespectsContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var attempts int
	p := newTestPlugin()
	p.skillExtractorURL = "http://extractor.invalid"
	p.http = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		attempts++
		cancel()
		return nil, fmt.Errorf("write extraction request: %w", syscall.EPIPE)
	})}

	queryBytes, err := json.Marshal(queryPayload{
		RequestID: "request-canceled-after-failure",
		Statement: "statement",
		HolderDID: "did:ethr:0x123",
	})
	if err != nil {
		t.Fatalf("marshal query: %v", err)
	}
	_, err = p.Observation(
		ctx,
		ocr3types.OutcomeContext{SeqNr: 29},
		types.Query(queryBytes),
	)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Observation error=%v, want context.Canceled", err)
	}
	if attempts != 1 {
		t.Fatalf("transport attempts=%d, want 1 after context cancellation", attempts)
	}
}

func TestRetryableObservationTransportErrorClassification(t *testing.T) {
	canceledContext, cancel := context.WithCancel(context.Background())
	cancel()

	tests := []struct {
		name      string
		ctx       context.Context
		err       error
		retryable bool
	}{
		{name: "broken pipe", ctx: context.Background(), err: fmt.Errorf("wrapped: %w", syscall.EPIPE), retryable: true},
		{name: "connection reset", ctx: context.Background(), err: fmt.Errorf("wrapped: %w", syscall.ECONNRESET), retryable: true},
		{name: "EOF", ctx: context.Background(), err: fmt.Errorf("wrapped: %w", io.EOF), retryable: true},
		{name: "unexpected EOF", ctx: context.Background(), err: fmt.Errorf("wrapped: %w", io.ErrUnexpectedEOF), retryable: true},
		{name: "transport timeout", ctx: context.Background(), err: timeoutTransportError{}, retryable: false},
		{name: "deadline exceeded", ctx: context.Background(), err: context.DeadlineExceeded, retryable: false},
		{name: "canceled context", ctx: canceledContext, err: fmt.Errorf("wrapped: %w", syscall.EPIPE), retryable: false},
		{name: "ordinary transport error", ctx: context.Background(), err: errors.New("certificate rejected"), retryable: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, retryable := retryableObservationTransportError(test.ctx, test.err)
			if retryable != test.retryable {
				t.Fatalf("retryable=%t, want %t for %v", retryable, test.retryable, test.err)
			}
		})
	}
}

func TestObservationContractModeDefaultsToRequestNotReceived(t *testing.T) {
	var stored storedObservation
	var storedCount int
	queue := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/requests/missing-request/query":
			http.NotFound(w, r)
		case r.Method == http.MethodPost && r.URL.Path == "/requests/missing-request/observations":
			storedCount++
			if err := json.NewDecoder(r.Body).Decode(&stored); err != nil {
				t.Fatalf("decode stored observation: %v", err)
			}
			w.WriteHeader(http.StatusOK)
		default:
			t.Fatalf("unexpected queue request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer queue.Close()

	p := newTestPlugin()
	p.requestSource = requestSourceChain
	p.queueURL = queue.URL
	p.skillExtractorURL = "http://unused"
	p.postObservations = true
	p.http = queue.Client()

	queryBytes, err := json.Marshal(queryPayload{
		RequestID:         "missing-request",
		RequesterEndpoint: "http://requester.example/results",
		Statement:         "statement",
		HolderDID:         "did:ethr:0x123",
		AuthorSkills:      []string{"(A, uri:a)"},
	})
	if err != nil {
		t.Fatalf("marshal query: %v", err)
	}

	obs, err := p.Observation(context.Background(), ocr3types.OutcomeContext{SeqNr: 7}, types.Query(queryBytes))
	if err != nil {
		t.Fatalf("Observation returned error: %v", err)
	}

	var got observationPayload
	if err := json.Unmarshal(obs, &got); err != nil {
		t.Fatalf("decode observation: %v", err)
	}
	if strings.Contains(string(obs), "participating") {
		t.Fatalf("expected observation JSON to omit participating, got %s", string(obs))
	}
	if got.Competent {
		t.Fatalf("expected competent=false when request was not received")
	}
	if got.Confidence != 0 {
		t.Fatalf("expected confidence=0, got %v", got.Confidence)
	}
	if got.Reason != "request not received" {
		t.Fatalf("expected reason=request not received, got %q", got.Reason)
	}
	if storedCount != 1 {
		t.Fatalf("expected one stored observation post, got %d", storedCount)
	}
	if stored.Reason != "request not received" {
		t.Fatalf("expected stored local observation for request-not-received, got %+v", stored)
	}
}

func TestShouldAcceptAttestedReportCompletesLocalQueueRequest(t *testing.T) {
	var completions []string
	queue := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("unexpected method %s", r.Method)
		}
		if !strings.HasSuffix(r.URL.Path, "/complete") {
			t.Fatalf("unexpected completion path %s", r.URL.Path)
		}
		completions = append(completions, r.URL.Path)
		w.WriteHeader(http.StatusOK)
	}))
	defer queue.Close()

	p := newTestPlugin()
	p.requestSource = requestSourceChain
	p.queueURL = queue.URL
	p.http = queue.Client()

	reportBytes, err := json.Marshal(outcomePayload{
		RequestID:         "req-complete",
		RequesterEndpoint: "http://requester.example/results",
		Statement:         "statement",
		HolderDID:         "did:ethr:0x123",
		Competent:         true,
		Confidence:        0.8,
		Reason:            "accepted",
	})
	if err != nil {
		t.Fatalf("marshal report: %v", err)
	}

	accepted, err := p.ShouldAcceptAttestedReport(context.Background(), 1, ocr3types.ReportWithInfo[struct{}]{
		Report: types.Report(reportBytes),
		Info:   struct{}{},
	})
	if err != nil {
		t.Fatalf("ShouldAcceptAttestedReport returned error: %v", err)
	}
	if !accepted {
		t.Fatalf("expected report to be accepted")
	}
	if len(completions) != 1 {
		t.Fatalf("expected one completion post, got %d", len(completions))
	}
	if completions[0] != "/requests/req-complete/complete" {
		t.Fatalf("unexpected completion path %q", completions[0])
	}
}

func TestDecodePreviousTrustRemapsByDID(t *testing.T) {
	prevTrust := &trustPayload{
		DIDs:     []string{"did:oracle:a", "did:oracle:b", "did:oracle:c", "did:oracle:old"},
		EpochLen: 1,
		Epoch:    7,
		Running: []trustOpinionBps{
			{B: 11, D: 22, U: 67},
			{B: 33, D: 44, U: 23},
			{B: 55, D: 11, U: 34},
			{B: 77, D: 0, U: 23},
		},
		Pending: []trustEvidenceCounts{
			{Pos: 1, Neg: 2, Unc: 3},
			{Pos: 4, Neg: 5, Unc: 6},
			{Pos: 7, Neg: 8, Unc: 9},
			{Pos: 10, Neg: 11, Unc: 12},
		},
	}
	prev := mustMarshalPreviousOutcome(t, prevTrust)

	got := decodePreviousTrust(prev, 4, []string{"did:oracle:b", "did:oracle:a", "did:oracle:c", "did:oracle:new"})

	if got.Epoch != 7 {
		t.Fatalf("expected epoch to survive DID remap, got %d", got.Epoch)
	}
	if got.DIDs[0] != "did:oracle:b" || got.DIDs[1] != "did:oracle:a" || got.DIDs[2] != "did:oracle:c" || got.DIDs[3] != "did:oracle:new" {
		t.Fatalf("expected current DID order to be stored, got %#v", got.DIDs)
	}
	if got.Running[0] != prevTrust.Running[1] {
		t.Fatalf("expected did:oracle:b trust to move into slot 0, got %+v", got.Running[0])
	}
	if got.Running[1] != prevTrust.Running[0] {
		t.Fatalf("expected did:oracle:a trust to move into slot 1, got %+v", got.Running[1])
	}
	if got.Running[2] != prevTrust.Running[2] {
		t.Fatalf("expected did:oracle:c trust to stay in slot 2, got %+v", got.Running[2])
	}
	if got.Running[3] != (trustOpinionBps{B: 0, D: 0, U: trustScale}) {
		t.Fatalf("expected new DID to start fully uncertain, got %+v", got.Running[3])
	}
	if got.Pending[0] != prevTrust.Pending[1] || got.Pending[1] != prevTrust.Pending[0] || got.Pending[2] != prevTrust.Pending[2] {
		t.Fatalf("expected pending evidence to follow DID remap, got %+v", got.Pending)
	}
	if got.Pending[3] != (trustEvidenceCounts{}) {
		t.Fatalf("expected new DID pending evidence to start empty, got %+v", got.Pending[3])
	}
}
