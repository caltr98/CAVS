//go:build !queue

package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto/kzg4844"
	"github.com/ethereum/go-ethereum/ethclient"
)

func TestBeaconBlobClientFallsBackToCachedPayloadWithoutBeaconURL(t *testing.T) {
	cacheDir := t.TempDir()
	requestID := "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	want := []byte(`{"version":"cavs-request-v1"}`)
	if err := os.WriteFile(filepath.Join(cacheDir, requestID+".json"), want, 0o600); err != nil {
		t.Fatalf("write cached payload: %v", err)
	}
	t.Setenv("OCR_REQUEST_BLOB_CACHE_DIR", cacheDir)

	client, err := newBeaconBlobClient("", nil)
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	got, err := client.fetchBlobPayloadByTxHash(context.Background(), nil, common.Hash{}, common.Hash{}, strings.ToUpper(requestID), common.Hash{})
	if err != nil {
		t.Fatalf("fetch cached payload: %v", err)
	}
	if string(got) != string(want) {
		t.Fatalf("cached payload = %s, want %s", got, want)
	}
}

func TestRequestBlobCacheFilenameRejectsUnsafeRequestID(t *testing.T) {
	if _, err := requestBlobCacheFilename("../bad"); err == nil {
		t.Fatalf("expected unsafe request id to be rejected")
	}
}

func TestFetchBeaconBlobsUsesVersionedHashFilter(t *testing.T) {
	wantPayload := []byte(`{"version":"cavs-request-v1","source":"anvil"}`)
	blobHex, _ := encodeBlobPayloadForTest(t, wantPayload)
	hashA := common.HexToHash("0x01aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01")
	hashB := common.HexToHash("0x01bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/eth/v1/beacon/blobs/0xblockhash" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		got := r.URL.Query()["versioned_hashes"]
		if len(got) != 2 || got[0] != hashA.Hex() || got[1] != hashB.Hex() {
			t.Fatalf("versioned_hashes = %v, want %s %s", got, hashA.Hex(), hashB.Hex())
		}
		fmt.Fprintf(w, `{"data":[%q],"execution_optimistic":false,"finalized":false}`, blobHex)
	}))
	defer server.Close()

	client, err := newBeaconBlobClient(server.URL, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	got, err := client.fetchBeaconBlobs(context.Background(), "0xblockhash", []common.Hash{hashA, hashB})
	if err != nil {
		t.Fatalf("fetch blobs: %v", err)
	}
	if len(got) != 1 || got[0].Blob != blobHex {
		t.Fatalf("blobs = %#v", got)
	}
}

func TestDecodeVerifiedBeaconBlobPayloadComputesCommitmentForAnvilBlob(t *testing.T) {
	wantPayload := []byte(`{"version":"cavs-request-v1","source":"anvil"}`)
	blobHex, blob := encodeBlobPayloadForTest(t, wantPayload)
	commitment, err := kzg4844.BlobToCommitment(&blob)
	if err != nil {
		t.Fatalf("compute commitment: %v", err)
	}
	wantHashBytes := kzg4844.CalcBlobHashV1(sha256.New(), &commitment)
	wantHash := common.BytesToHash(wantHashBytes[:])

	gotPayload, gotHash, err := decodeVerifiedBeaconBlobPayload(beaconBlobData{Blob: blobHex})
	if err != nil {
		t.Fatalf("decode verified blob: %v", err)
	}
	if string(gotPayload) != string(wantPayload) {
		t.Fatalf("payload = %s, want %s", gotPayload, wantPayload)
	}
	if gotHash != wantHash {
		t.Fatalf("versioned hash = %s, want %s", gotHash.Hex(), wantHash.Hex())
	}
}

func TestDecodeBlobPayloadSupportsRawPaddedEthersBlob(t *testing.T) {
	wantPayload := []byte(`{"version":"cavs-request-v1","source":"ethers"}`)
	var blob kzg4844.Blob
	copy(blob[:], wantPayload)
	got, err := decodeBlobPayloadBytes(blob[:])
	if err != nil {
		t.Fatalf("decode raw padded blob: %v", err)
	}
	if string(got) != string(wantPayload) {
		t.Fatalf("payload = %s, want %s", got, wantPayload)
	}
}

func TestDecodeVerifiedBeaconBlobPayloadVerifiesSidecarProof(t *testing.T) {
	wantPayload := []byte(`{"version":"cavs-request-v1","source":"sidecar"}`)
	blobHex, blob := encodeBlobPayloadForTest(t, wantPayload)
	commitment, err := kzg4844.BlobToCommitment(&blob)
	if err != nil {
		t.Fatalf("compute commitment: %v", err)
	}
	proof, err := kzg4844.ComputeBlobProof(&blob, commitment)
	if err != nil {
		t.Fatalf("compute proof: %v", err)
	}

	gotPayload, _, err := decodeVerifiedBeaconBlobPayload(beaconBlobData{
		Blob:          blobHex,
		KZGCommitment: "0x" + hex.EncodeToString(commitment[:]),
		KZGProof:      "0x" + hex.EncodeToString(proof[:]),
	})
	if err != nil {
		t.Fatalf("decode verified blob sidecar: %v", err)
	}
	if string(gotPayload) != string(wantPayload) {
		t.Fatalf("payload = %s, want %s", gotPayload, wantPayload)
	}
}

func TestBeaconBlobClientFetchesAnvilBlobByBlockHashIntegration(t *testing.T) {
	rpcURL := strings.TrimSpace(os.Getenv("CAVSONOCR_ANVIL_RPC_URL"))
	txHashHex := strings.TrimSpace(os.Getenv("CAVSONOCR_ANVIL_BLOB_TX_HASH"))
	if rpcURL == "" || txHashHex == "" {
		t.Skip("set CAVSONOCR_ANVIL_RPC_URL and CAVSONOCR_ANVIL_BLOB_TX_HASH to run")
	}
	beaconURL := strings.TrimSpace(os.Getenv("CAVSONOCR_ANVIL_BEACON_URL"))
	if beaconURL == "" {
		beaconURL = rpcURL
	}
	wantPayload := os.Getenv("CAVSONOCR_ANVIL_BLOB_PAYLOAD")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	eth, err := ethclient.DialContext(ctx, rpcURL)
	if err != nil {
		t.Fatalf("dial anvil rpc: %v", err)
	}
	defer eth.Close()

	txHash := common.HexToHash(txHashHex)
	receipt, err := eth.TransactionReceipt(ctx, txHash)
	if err != nil {
		t.Fatalf("load anvil tx receipt: %v", err)
	}

	t.Setenv("OCR_BEACON_BLOB_ID_MODE", beaconBlobIDModeBlockHash)
	client, err := newBeaconBlobClient(beaconURL, nil)
	if err != nil {
		t.Fatalf("new beacon client: %v", err)
	}
	got, err := client.fetchBlobPayloadByTxHash(ctx, eth, txHash, receipt.BlockHash, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", common.Hash{})
	if err != nil {
		t.Fatalf("fetch anvil blob payload: %v", err)
	}
	if wantPayload != "" && string(got) != wantPayload {
		t.Fatalf("payload = %q, want %q", got, wantPayload)
	}
	if len(got) == 0 {
		t.Fatalf("expected non-empty blob payload")
	}
}

func encodeBlobPayloadForTest(t *testing.T, payload []byte) (string, kzg4844.Blob) {
	t.Helper()
	if len(payload) > blobMaxPayloadBytesWithPrefix-4 {
		t.Fatalf("payload too large: %d", len(payload))
	}
	payloadLane := make([]byte, blobMaxPayloadBytesWithPrefix)
	binary.BigEndian.PutUint32(payloadLane[:4], uint32(len(payload)))
	copy(payloadLane[4:], payload)

	var blob kzg4844.Blob
	for i := 0; i < blobFieldElements; i++ {
		srcStart := i * blobPayloadBytesPerElement
		dstStart := i*blobElementBytes + 1
		copy(blob[dstStart:dstStart+blobPayloadBytesPerElement], payloadLane[srcStart:srcStart+blobPayloadBytesPerElement])
	}
	return "0x" + hex.EncodeToString(blob[:]), blob
}
