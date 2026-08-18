//go:build !queue

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	neturl "net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto/kzg4844"
	"github.com/ethereum/go-ethereum/ethclient"
)

const (
	beaconSecondsPerSlot          = 12
	blobFieldElements             = 4096
	blobElementBytes              = 32
	blobPayloadBytesPerElement    = 31
	blobTotalBytes                = blobFieldElements * blobElementBytes
	blobMaxPayloadBytesWithPrefix = blobFieldElements * blobPayloadBytesPerElement
	defaultRequestBlobCacheDir    = "/registry/request-blobs"

	// blob_sidecars/{block_id} identifier styles. Real consensus clients and
	// Alchemy expect a numeric beacon slot derived from genesis time. Anvil
	// has no consensus layer: it interprets a numeric block_id as an
	// execution block number and also accepts the execution block hash, so
	// against Anvil the slot arithmetic resolves to the wrong block.
	beaconBlobIDModeSlot      = "slot"
	beaconBlobIDModeBlockHash = "block_hash"
)

type beaconBlobClient struct {
	baseURL    string
	cacheDir   string
	blobIDMode string
	httpClient *http.Client

	mu          sync.Mutex
	genesisTime uint64
}

type beaconGenesisResponse struct {
	Data struct {
		GenesisTime string `json:"genesis_time"`
	} `json:"data"`
}

type beaconBlobSidecarsResponse struct {
	Data []beaconBlobData `json:"data"`
}

type beaconBlobsResponse struct {
	Data []beaconBlobData `json:"data"`
}

type beaconBlobData struct {
	Index         string `json:"index"`
	Blob          string `json:"blob"`
	KZGCommitment string `json:"kzg_commitment"`
	KZGProof      string `json:"kzg_proof"`
}

func (b *beaconBlobData) UnmarshalJSON(input []byte) error {
	var blobOnly string
	if err := json.Unmarshal(input, &blobOnly); err == nil {
		b.Blob = blobOnly
		return nil
	}
	type sidecar beaconBlobData
	var decoded sidecar
	if err := json.Unmarshal(input, &decoded); err != nil {
		return err
	}
	*b = beaconBlobData(decoded)
	return nil
}

func resolveBeaconAPIURL(explicitURL string, executionRPCURL string) string {
	if explicit := strings.TrimRight(strings.TrimSpace(explicitURL), "/"); explicit != "" {
		return explicit
	}
	rawExecURL := strings.TrimSpace(executionRPCURL)
	if rawExecURL == "" {
		return ""
	}
	parsed, err := neturl.Parse(rawExecURL)
	if err != nil {
		return ""
	}
	host := strings.TrimSpace(parsed.Hostname())
	if host == "" {
		return ""
	}
	if strings.HasSuffix(host, ".g.alchemy.com") && strings.HasPrefix(host, "eth-") {
		beaconHost := strings.TrimSuffix(host, ".g.alchemy.com") + "beacon.g.alchemy.com"
		parsed.Host = strings.Replace(parsed.Host, host, beaconHost, 1)
		return strings.TrimRight(parsed.String(), "/")
	}
	return ""
}

func newBeaconBlobClient(baseURL string, httpClient *http.Client) (*beaconBlobClient, error) {
	normalized := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if httpClient == nil {
		httpClient = &http.Client{}
	}
	cacheDir := strings.TrimSpace(os.Getenv("OCR_REQUEST_BLOB_CACHE_DIR"))
	if cacheDir == "" {
		cacheDir = defaultRequestBlobCacheDir
	}
	blobIDMode := strings.ToLower(strings.TrimSpace(os.Getenv("OCR_BEACON_BLOB_ID_MODE")))
	switch blobIDMode {
	case "":
		blobIDMode = beaconBlobIDModeSlot
	case beaconBlobIDModeSlot, beaconBlobIDModeBlockHash:
	default:
		return nil, fmt.Errorf("invalid OCR_BEACON_BLOB_ID_MODE %q (want %q or %q)", blobIDMode, beaconBlobIDModeSlot, beaconBlobIDModeBlockHash)
	}
	return &beaconBlobClient{
		baseURL:    normalized,
		cacheDir:   cacheDir,
		blobIDMode: blobIDMode,
		httpClient: httpClient,
	}, nil
}

func (c *beaconBlobClient) fetchBlobPayloadByTxHash(ctx context.Context, eth *ethclient.Client, txHash common.Hash, blockHash common.Hash, requestID string, expectedBlobHash common.Hash) ([]byte, error) {
	if strings.TrimSpace(c.baseURL) == "" {
		return c.fetchCachedBlobPayload(requestID)
	}
	if eth == nil {
		return nil, fmt.Errorf("missing execution client for blob retrieval")
	}
	tx, _, err := eth.TransactionByHash(ctx, txHash)
	if err != nil {
		return nil, fmt.Errorf("load blob tx %s: %w", txHash.Hex(), err)
	}
	blobHashes := tx.BlobHashes()
	if len(blobHashes) == 0 {
		return nil, fmt.Errorf("tx %s has no blob versioned hashes", txHash.Hex())
	}
	allowedList := make([]common.Hash, 0, len(blobHashes)+1)
	allowed := make(map[common.Hash]struct{}, len(blobHashes)+1)
	for _, hash := range blobHashes {
		allowed[hash] = struct{}{}
		allowedList = append(allowedList, hash)
	}
	if expectedBlobHash != (common.Hash{}) {
		if _, ok := allowed[expectedBlobHash]; !ok {
			allowedList = append(allowedList, expectedBlobHash)
		}
		allowed[expectedBlobHash] = struct{}{}
	}
	blockID := blockHash.Hex()
	if c.blobIDMode == beaconBlobIDModeSlot {
		header, err := eth.HeaderByHash(ctx, blockHash)
		if err != nil {
			return nil, fmt.Errorf("load execution block header %s: %w", blockHash.Hex(), err)
		}
		slot, err := c.slotForExecutionTimestamp(ctx, header.Time)
		if err != nil {
			return nil, err
		}
		blockID = fmt.Sprintf("%d", slot)
	}

	blobs, blobsErr := c.fetchBeaconBlobs(ctx, blockID, allowedList)
	if blobsErr == nil {
		if payload, ok, err := decodeMatchingBeaconBlobPayload(blobs, allowed); err != nil {
			return nil, fmt.Errorf("decode beacon blob for request %s: %w", requestID, err)
		} else if ok {
			return payload, nil
		}
	}

	sidecars, sidecarsErr := c.fetchBlobSidecars(ctx, blockID)
	if sidecarsErr != nil {
		if blobsErr != nil {
			return nil, fmt.Errorf("fetch beacon blobs for request %s: %v; fetch beacon blob sidecars: %w", requestID, blobsErr, sidecarsErr)
		}
		return nil, sidecarsErr
	}
	if payload, ok, err := decodeMatchingBeaconBlobPayload(sidecars, allowed); err != nil {
		return nil, fmt.Errorf("decode beacon blob sidecar for request %s: %w", requestID, err)
	} else if ok {
		return payload, nil
	}
	if blobsErr != nil {
		return nil, fmt.Errorf("no matching blob found for request %s tx=%s block_id=%s; fetch beacon blobs: %w", requestID, txHash.Hex(), blockID, blobsErr)
	}
	return nil, fmt.Errorf("no matching blob found for request %s tx=%s block_id=%s", requestID, txHash.Hex(), blockID)
}

func (c *beaconBlobClient) fetchCachedBlobPayload(requestID string) ([]byte, error) {
	filename, err := requestBlobCacheFilename(requestID)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(c.cacheDir) == "" {
		return nil, fmt.Errorf("missing local request blob cache dir")
	}
	path := filepath.Join(c.cacheDir, filename)
	payload, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read cached request blob %s: %w", path, err)
	}
	return payload, nil
}

func requestBlobCacheFilename(requestID string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(requestID))
	if len(normalized) != 66 || !strings.HasPrefix(normalized, "0x") {
		return "", fmt.Errorf("invalid request id for blob cache: %q", requestID)
	}
	for _, ch := range normalized[2:] {
		if (ch < '0' || ch > '9') && (ch < 'a' || ch > 'f') {
			return "", fmt.Errorf("invalid request id for blob cache: %q", requestID)
		}
	}
	return normalized + ".json", nil
}

func (c *beaconBlobClient) slotForExecutionTimestamp(ctx context.Context, executionTimestamp uint64) (uint64, error) {
	genesisTime, err := c.getGenesisTime(ctx)
	if err != nil {
		return 0, err
	}
	if executionTimestamp < genesisTime {
		return 0, fmt.Errorf("execution timestamp %d predates beacon genesis %d", executionTimestamp, genesisTime)
	}
	return (executionTimestamp - genesisTime) / beaconSecondsPerSlot, nil
}

func (c *beaconBlobClient) getGenesisTime(ctx context.Context) (uint64, error) {
	c.mu.Lock()
	if c.genesisTime != 0 {
		genesisTime := c.genesisTime
		c.mu.Unlock()
		return genesisTime, nil
	}
	c.mu.Unlock()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/eth/v1/beacon/genesis", nil)
	if err != nil {
		return 0, err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("fetch beacon genesis: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return 0, fmt.Errorf("fetch beacon genesis: http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var decoded beaconGenesisResponse
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		return 0, fmt.Errorf("decode beacon genesis: %w", err)
	}
	genesisTime, err := parseUint64String(decoded.Data.GenesisTime, "beacon genesis_time")
	if err != nil {
		return 0, err
	}
	c.mu.Lock()
	if c.genesisTime == 0 {
		c.genesisTime = genesisTime
	}
	c.mu.Unlock()
	return genesisTime, nil
}

func (c *beaconBlobClient) fetchBeaconBlobs(ctx context.Context, blockID string, versionedHashes []common.Hash) ([]beaconBlobData, error) {
	endpoint := fmt.Sprintf("%s/eth/v1/beacon/blobs/%s", c.baseURL, blockID)
	query := neturl.Values{}
	for _, hash := range versionedHashes {
		if hash != (common.Hash{}) {
			query.Add("versioned_hashes", hash.Hex())
		}
	}
	if encoded := query.Encode(); encoded != "" {
		endpoint += "?" + encoded
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch beacon blobs for block_id %s: %w", blockID, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("fetch beacon blobs for block_id %s: http %d: %s", blockID, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var decoded beaconBlobsResponse
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		return nil, fmt.Errorf("decode beacon blobs for block_id %s: %w", blockID, err)
	}
	return decoded.Data, nil
}

func (c *beaconBlobClient) fetchBlobSidecars(ctx context.Context, blockID string) ([]beaconBlobData, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/eth/v1/beacon/blob_sidecars/%s", c.baseURL, blockID), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch beacon blob sidecars for block_id %s: %w", blockID, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("fetch beacon blob sidecars for block_id %s: http %d: %s", blockID, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var decoded beaconBlobSidecarsResponse
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		return nil, fmt.Errorf("decode beacon blob sidecars for block_id %s: %w", blockID, err)
	}
	return decoded.Data, nil
}

func versionedHashFromCommitment(commitmentHex string) (common.Hash, error) {
	commitment, err := decodeKZGCommitment(commitmentHex)
	if err != nil {
		return common.Hash{}, err
	}
	versionedHash := kzg4844.CalcBlobHashV1(sha256.New(), &commitment)
	return common.BytesToHash(versionedHash[:]), nil
}

func decodeKZGCommitment(commitmentHex string) (kzg4844.Commitment, error) {
	commitmentBytes, err := hex.DecodeString(strings.TrimPrefix(strings.TrimSpace(commitmentHex), "0x"))
	if err != nil {
		return kzg4844.Commitment{}, fmt.Errorf("decode kzg commitment: %w", err)
	}
	if len(commitmentBytes) != len(kzg4844.Commitment{}) {
		return kzg4844.Commitment{}, fmt.Errorf("unexpected kzg commitment size %d", len(commitmentBytes))
	}
	var commitment kzg4844.Commitment
	copy(commitment[:], commitmentBytes)
	return commitment, nil
}

func decodeKZGProof(proofHex string) (kzg4844.Proof, error) {
	proofBytes, err := hex.DecodeString(strings.TrimPrefix(strings.TrimSpace(proofHex), "0x"))
	if err != nil {
		return kzg4844.Proof{}, fmt.Errorf("decode kzg proof: %w", err)
	}
	if len(proofBytes) != len(kzg4844.Proof{}) {
		return kzg4844.Proof{}, fmt.Errorf("unexpected kzg proof size %d", len(proofBytes))
	}
	var proof kzg4844.Proof
	copy(proof[:], proofBytes)
	return proof, nil
}

func decodeMatchingBeaconBlobPayload(blobs []beaconBlobData, allowed map[common.Hash]struct{}) ([]byte, bool, error) {
	for _, blobData := range blobs {
		payload, versionedHash, err := decodeVerifiedBeaconBlobPayload(blobData)
		if err != nil {
			return nil, false, err
		}
		if _, ok := allowed[versionedHash]; !ok {
			continue
		}
		return payload, true, nil
	}
	return nil, false, nil
}

func decodeVerifiedBeaconBlobPayload(blobData beaconBlobData) ([]byte, common.Hash, error) {
	blob, err := decodeKZGBlob(blobData.Blob)
	if err != nil {
		return nil, common.Hash{}, err
	}
	commitmentHex := strings.TrimSpace(blobData.KZGCommitment)
	var commitment kzg4844.Commitment
	if commitmentHex != "" {
		commitment, err = decodeKZGCommitment(commitmentHex)
		if err != nil {
			return nil, common.Hash{}, err
		}
		if proofHex := strings.TrimSpace(blobData.KZGProof); proofHex != "" {
			proof, err := decodeKZGProof(proofHex)
			if err != nil {
				return nil, common.Hash{}, err
			}
			if err := kzg4844.VerifyBlobProof(&blob, commitment, proof); err != nil {
				return nil, common.Hash{}, fmt.Errorf("verify kzg blob proof: %w", err)
			}
		} else {
			computed, err := kzg4844.BlobToCommitment(&blob)
			if err != nil {
				return nil, common.Hash{}, fmt.Errorf("compute kzg blob commitment: %w", err)
			}
			if computed != commitment {
				return nil, common.Hash{}, fmt.Errorf("kzg blob commitment mismatch")
			}
		}
	} else {
		commitment, err = kzg4844.BlobToCommitment(&blob)
		if err != nil {
			return nil, common.Hash{}, fmt.Errorf("compute kzg blob commitment: %w", err)
		}
	}
	versionedHashBytes := kzg4844.CalcBlobHashV1(sha256.New(), &commitment)
	versionedHash := common.BytesToHash(versionedHashBytes[:])
	payload, err := decodeBlobPayloadBytes(blob[:])
	if err != nil {
		return nil, common.Hash{}, err
	}
	return payload, versionedHash, nil
}

func decodeBlobPayload(blobHex string) ([]byte, error) {
	blob, err := decodeKZGBlob(blobHex)
	if err != nil {
		return nil, err
	}
	return decodeBlobPayloadBytes(blob[:])
}

func decodeKZGBlob(blobHex string) (kzg4844.Blob, error) {
	blobBytes, err := hex.DecodeString(strings.TrimPrefix(strings.TrimSpace(blobHex), "0x"))
	if err != nil {
		return kzg4844.Blob{}, fmt.Errorf("decode blob hex: %w", err)
	}
	if len(blobBytes) != blobTotalBytes {
		return kzg4844.Blob{}, fmt.Errorf("unexpected blob size %d", len(blobBytes))
	}
	var blob kzg4844.Blob
	copy(blob[:], blobBytes)
	return blob, nil
}

func decodeBlobPayloadBytes(blobBytes []byte) ([]byte, error) {
	if len(blobBytes) != blobTotalBytes {
		return nil, fmt.Errorf("unexpected blob size %d", len(blobBytes))
	}
	payloadLane := make([]byte, blobMaxPayloadBytesWithPrefix)
	for i := 0; i < blobFieldElements; i++ {
		srcStart := i*blobElementBytes + 1
		srcEnd := srcStart + blobPayloadBytesPerElement
		dstStart := i * blobPayloadBytesPerElement
		copy(payloadLane[dstStart:dstStart+blobPayloadBytesPerElement], blobBytes[srcStart:srcEnd])
	}
	payloadLength := binary.BigEndian.Uint32(payloadLane[:4])
	if payloadLength > 0 && payloadLength <= uint32(len(payloadLane)-4) {
		out := make([]byte, payloadLength)
		copy(out, payloadLane[4:4+payloadLength])
		return out, nil
	}

	trimmed := bytes.TrimRight(blobBytes, "\x00")
	if len(trimmed) == 0 {
		return nil, fmt.Errorf("empty blob payload")
	}
	out := make([]byte, len(trimmed))
	copy(out, trimmed)
	return out, nil
}

func parseUint64String(raw string, label string) (uint64, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return 0, fmt.Errorf("missing %s", label)
	}
	var value uint64
	for _, ch := range trimmed {
		if ch < '0' || ch > '9' {
			return 0, fmt.Errorf("invalid %s %q", label, raw)
		}
		value = value*10 + uint64(ch-'0')
	}
	return value, nil
}
