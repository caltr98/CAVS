//go:build !queue

// This file is the entrypoint for the oracle/bootstrap binary ("cavs-oracle").
//
// The queue node is a separate binary built with `-tags queue` ("cavs-queue").
//
// How the OCR3 pipeline maps to THIS file:
//
//  1. "Query" phase (leader only):
//     cavsPlugin.Query() fetches a pending request from the selected backend:
//     the leader's embedded request queue for contract/registry requests.
//     Leader broadcasts it as MessageRoundStart{Query} (handled inside libocr).
//
//  2. "Observation" phase (all oracles):
//     cavsPlugin.Observation() calls the skill extractor and produces a byte
//     slice (types.Observation). Followers sign it and send MessageObservation
//     to the leader (handled inside libocr).
//
//  3. "Outcome" phase (all oracles, deterministic):
//     cavsPlugin.Outcome() aggregates the attributed observations into a single
//     ocr3types.Outcome (here: mean confidence with 2f+1 support).
//     Every oracle must compute the SAME bytes, or signatures will not verify.
//
//  4. "Reports" phase (all oracles, deterministic):
//     cavsPlugin.Reports() turns the Outcome into report bytes to be signed.
//     (Here we just reuse the outcome bytes as the report.)
//
//  5. "Report attestation" + "Transmission" (libocr):
//     libocr gathers onchain signatures for each report and (depending on the
//     transmission schedule) calls ContractTransmitter.Transmit().
//     logTransmitter.Transmit() logs + sends the result back to the selected
//     backend (queue result endpoint or requester callback).
//
// If you want to follow the actual message types exchanged, see:
// `libocr/libocr/offchainreporting2plus/internal/ocr3/protocol/message.go`.
package main

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	minilm "cavs/cavsonocr/internal/minilm"
	noncentralizedclient "cavs/cavsonocr/oracle/noncentralized/client"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/smartcontractkit/libocr/commontypes"
	"github.com/smartcontractkit/libocr/networking"
	"github.com/smartcontractkit/libocr/offchainreporting2plus"
	"github.com/smartcontractkit/libocr/offchainreporting2plus/chains/evmutil"
	"github.com/smartcontractkit/libocr/offchainreporting2plus/confighelper"
	"github.com/smartcontractkit/libocr/offchainreporting2plus/ocr3confighelper"
	"github.com/smartcontractkit/libocr/offchainreporting2plus/ocr3types"
	"github.com/smartcontractkit/libocr/offchainreporting2plus/types"
	ragetypes "github.com/smartcontractkit/libocr/ragep2p/types"
)

const maxRequesterRelayFailures = 5
const defaultONNXRuntimePath = "/usr/local/lib/libonnxruntime.so"
const defaultMiniLMModelPath = "/usr/local/share/minilm/model.onnx"
const defaultRequestImportWaitTimeout = 5 * time.Second
const geometricMedianMaxIterations = 128
const geometricMedianTolerance = 1e-7
const observationHTTPMaxAttempts = 2
const observationHTTPIdleConnTimeout = 60 * time.Second
const observationIdempotencyHeader = "Idempotency-Key"
const observationRequestIdentityHeader = "X-CAVS-Request-ID"
const (
	phaseEventPickup   = "EVENT_PICKUP"
	phaseQuery         = "QUERY"
	phaseObservation   = "OBSERVATION"
	phaseOutcome       = "OUTCOME"
	phaseReports       = "REPORTS"
	phaseAcceptCheck   = "ACCEPT_CHECK"
	phaseTransmitCheck = "TRANSMIT_CHECK"
	phaseTransmitTotal = "TRANSMIT_TOTAL"
)

var phaseSleepOrder = []string{
	phaseEventPickup,
	phaseRoundAdmission,
	phaseQuery,
	phaseObservation,
	phaseOutcome,
	phaseReports,
	phaseAcceptCheck,
	phaseTransmitCheck,
	phaseTransmitTotal,
}

var phaseSleepEnvironment = map[string]string{
	phaseEventPickup:    "OCR_PHASE_SLEEP_EVENT_PICKUP",
	phaseRoundAdmission: "OCR_PHASE_SLEEP_ROUND_ADMISSION",
	phaseQuery:          "OCR_PHASE_SLEEP_QUERY",
	phaseObservation:    "OCR_PHASE_SLEEP_OBSERVATION",
	phaseOutcome:        "OCR_PHASE_SLEEP_OUTCOME",
	phaseReports:        "OCR_PHASE_SLEEP_REPORTS",
	phaseAcceptCheck:    "OCR_PHASE_SLEEP_ACCEPT_CHECK",
	phaseTransmitCheck:  "OCR_PHASE_SLEEP_TRANSMIT_CHECK",
	phaseTransmitTotal:  "OCR_PHASE_SLEEP_TRANSMIT_TOTAL",
}

// configuredPhaseSleeps is immutable after main has validated the environment.
// Keeping the intervention in one shared object lets the request bridge and
// every OCR callback use exactly the same declared treatment.
var configuredPhaseSleeps phaseSleepConfig

type phaseSleepConfig struct {
	durations map[string]time.Duration
}

func loadPhaseSleepConfig() (phaseSleepConfig, error) {
	cfg := phaseSleepConfig{durations: make(map[string]time.Duration, len(phaseSleepOrder))}
	for _, phase := range phaseSleepOrder {
		name := phaseSleepEnvironment[phase]
		raw := strings.TrimSpace(os.Getenv(name))
		if raw == "" {
			continue
		}
		duration, err := time.ParseDuration(raw)
		if err != nil {
			return phaseSleepConfig{}, fmt.Errorf("parse %s=%q: %w", name, raw, err)
		}
		if duration < 0 || duration > maxInjectedPhaseSleep {
			return phaseSleepConfig{}, fmt.Errorf(
				"%s must be between 0 and %s, got %s",
				name,
				maxInjectedPhaseSleep,
				duration,
			)
		}
		if duration > 0 {
			cfg.durations[phase] = duration
		}
	}
	return cfg, nil
}

func (cfg phaseSleepConfig) duration(phase string) time.Duration {
	if cfg.durations == nil {
		return 0
	}
	return cfg.durations[phase]
}

func (cfg phaseSleepConfig) String() string {
	values := make([]string, 0, len(phaseSleepOrder))
	for _, phase := range phaseSleepOrder {
		if duration := cfg.duration(phase); duration > 0 {
			values = append(values, phase+"="+duration.String())
		}
	}
	if len(values) == 0 {
		return "none"
	}
	return strings.Join(values, ",")
}

func (cfg phaseSleepConfig) sleep(ctx context.Context, phase string, metrics *metricRecorder, seqNr uint64) error {
	duration := cfg.duration(phase)
	if duration <= 0 {
		return nil
	}
	start := time.Now()
	fmt.Printf("[PHASE-SLEEP] phase=%s configured=%s seqNr=%d\n", phase, duration, seqNr)
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		actual := time.Since(start)
		metrics.recordDuration("INJECTED_SLEEP_"+phase, seqNr, 0, actual)
		return ctx.Err()
	case <-timer.C:
		actual := time.Since(start)
		metrics.recordDuration("INJECTED_SLEEP_"+phase, seqNr, 0, actual)
		return nil
	}
}

// reasonEmbeddingQuantizationScale snaps raw MiniLM/ONNX embedding coordinates
// onto a fixed integer grid (grid step = 1/scale) BEFORE any distance or
// geometric-median math runs. MiniLM embeddings are ~L2-normalized into [-1,1],
// so a scale of 1000 gives a 1e-3 grid. Cross-hardware / cross-thread-count ONNX
// float differences are on the order of 1e-6, far below half a grid step, so all
// honest nodes snap to identical integer vectors. Once inputs are identical
// integers, the downstream Go float64 arithmetic is IEEE-754 deterministic (Go
// uses no x87 extended precision and no implicit FMA), so every node selects the
// SAME median reason. This keeps the reason — which is part of the signed outcome
// bytes — reproducible across a heterogeneous DON instead of depending on the
// exact float output of each node's ONNX build.
const reasonEmbeddingQuantizationScale = 1000.0

// redactURLForLog deliberately keeps only the transport and authority. RPC
// providers commonly place credentials in URL paths, userinfo or query
// strings; none of those belong in reviewer logs or benchmark artifacts.
func redactURLForLog(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "<configured>"
	}
	return parsed.Scheme + "://" + parsed.Host
}

func logGoRuntimeMetrics(ctx context.Context, oracleID int) {
	interval := 10 * time.Second
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			var stats runtime.MemStats
			runtime.ReadMemStats(&stats)
			fmt.Printf("[RESOURCE-GO] oracle=%d heap_alloc_bytes=%d heap_sys_bytes=%d gc_pause_total_ns=%d num_gc=%d goroutines=%d\n",
				oracleID, stats.HeapAlloc, stats.HeapSys, stats.PauseTotalNs, stats.NumGC, runtime.NumGoroutine())
		}
	}
}

var defaultMiniLMReasonEmbedder = newMiniLMReasonEmbedder(defaultONNXRuntimePath, defaultMiniLMModelPath)
var errMissingRequesterEndpoint = errors.New("missing requesterEndpoint")
var errReasonEmbeddingUnavailable = errors.New("reason embedding unavailable")
var reasonEmbeddingUnavailableLogOnce sync.Once

const (
	fixedTrustEpochLen = 1
	fixedSkillsTopK    = 50
	trustScale         = 100
	requestSourceChain = "contract"
)

// quietLogger implements libocr's logger interface but intentionally drops most
// log levels to keep the console output focused on this service's fmt.Printf
// lines (QUERY/OBS/TRANSMIT).
type quietLogger struct{ *log.Logger }

func (l quietLogger) Trace(string, commontypes.LogFields)          {}
func (l quietLogger) Debug(string, commontypes.LogFields)          {}
func (l quietLogger) Info(string, commontypes.LogFields)           {}
func (l quietLogger) Warn(string, commontypes.LogFields)           {}
func (l quietLogger) Error(msg string, f commontypes.LogFields)    { l.Println("ERROR", msg, f) }
func (l quietLogger) Critical(msg string, f commontypes.LogFields) { l.Println("CRIT", msg, f) }

type noopMonitoring struct{}

// noopMonitoring is a stub MonitoringEndpoint. In production you would export
// libocr telemetry/logs to your monitoring system.
func (noopMonitoring) SendLog([]byte) {}

type memDB3 struct {
	mu    sync.Mutex
	cfg   *types.ContractConfig
	state map[string]map[string][]byte // configDigestHex -> key -> value
}

// cloneContractConfig keeps the in-memory database boundary honest: libocr is
// free to retain or mutate the slices it passes to/receives from Database, so
// storing the caller's backing arrays directly would make concurrent reads and
// writes race even when access to m.cfg itself is locked.
func cloneContractConfig(in types.ContractConfig) types.ContractConfig {
	out := in
	if len(in.Signers) > 0 {
		out.Signers = make([]types.OnchainPublicKey, len(in.Signers))
		for i, signer := range in.Signers {
			out.Signers[i] = append(types.OnchainPublicKey(nil), signer...)
		}
	}
	out.Transmitters = append([]types.Account(nil), in.Transmitters...)
	out.OnchainConfig = append([]byte(nil), in.OnchainConfig...)
	out.OffchainConfig = append([]byte(nil), in.OffchainConfig...)
	return out
}

// ReadConfig returns the latest contract config the protocol should run with.
// In a real deployment this would come from chain (via ContractConfigTracker)
// and be persisted in a durable DB.
func (m *memDB3) ReadConfig(context.Context) (*types.ContractConfig, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cfg == nil {
		return nil, nil
	}
	cfg := cloneContractConfig(*m.cfg)
	return &cfg, nil
}

// WriteConfig stores the current contract config.
func (m *memDB3) WriteConfig(_ context.Context, c types.ContractConfig) error {
	cfg := cloneContractConfig(c)
	m.mu.Lock()
	m.cfg = &cfg
	m.mu.Unlock()
	return nil
}

// ReadProtocolState returns protocol-internal persisted state (per configDigest).
// libocr uses this to survive restarts and avoid safety bugs.
func (m *memDB3) ReadProtocolState(_ context.Context, d types.ConfigDigest, key string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state == nil {
		return nil, nil
	}
	kv := m.state[d.Hex()]
	if kv == nil {
		return nil, nil
	}
	v := kv[key]
	if v == nil {
		return nil, nil
	}
	out := make([]byte, len(v))
	copy(out, v)
	return out, nil
}

// WriteProtocolState stores protocol-internal persisted state (per configDigest).
func (m *memDB3) WriteProtocolState(_ context.Context, d types.ConfigDigest, key string, value []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state == nil {
		m.state = map[string]map[string][]byte{}
	}
	if m.state[d.Hex()] == nil {
		m.state[d.Hex()] = map[string][]byte{}
	}
	if value == nil {
		delete(m.state[d.Hex()], key)
		return nil
	}
	v := make([]byte, len(value))
	copy(v, value)
	m.state[d.Hex()][key] = v
	return nil
}

type staticTracker struct {
	cfg types.ContractConfig
}

// staticTracker is a tiny ContractConfigTracker implementation that always
// returns the single config we computed in buildContractConfig().
//
// Real OCR runs with a ContractConfigTracker that watches chain logs / RPC for
// config changes.
func (t staticTracker) Notify() <-chan struct{} { return nil }
func (t staticTracker) LatestConfigDetails(context.Context) (uint64, types.ConfigDigest, error) {
	return 1, t.cfg.ConfigDigest, nil
}
func (t staticTracker) LatestConfig(context.Context, uint64) (types.ContractConfig, error) {
	return t.cfg, nil
}
func (t staticTracker) LatestBlockHeight(context.Context) (uint64, error) { return 1, nil }

// minimal requirement to identify a DID in the DON
type didRegistryEntry struct {
	OracleID int    `json:"oracle_id"`
	DID      string `json:"did"`
}

func registryDIDs(registry []didRegistryEntry) []string {
	out := make([]string, len(registry))
	for i, entry := range registry {
		out[i] = strings.TrimSpace(entry.DID)
	}
	return out
}

// cavsOnchainKeyring implements the OCR3 onchain keyring by delegating all
// signing and verification to the oracle's local CAVS service.
//
// OCR  identifies each oracle by a 20-byte Ethereum address, we
// persists on the registry the did:ethr identity. The address is resolved through
// CAVS whenever OCR needs its onchain key representation.
type cavsOnchainKeyring struct {
	oracleID          int
	cavsURL           string
	did               string
	publicKey         types.OnchainPublicKey
	registryByAddress map[string]didRegistryEntry
	http              *http.Client
}

func normalizeEthAddress(address string) (string, error) {
	if !common.IsHexAddress(address) {
		return "", fmt.Errorf("invalid Ethereum address %q", address)
	}
	return common.HexToAddress(address).Hex(), nil
}

func onchainPublicKeyFromAddress(address string) (types.OnchainPublicKey, types.Account, error) {
	addr, err := normalizeEthAddress(address)
	if err != nil {
		return nil, "", err
	}
	pub := common.HexToAddress(addr).Bytes()
	return types.OnchainPublicKey(pub), types.Account(addr), nil
}

func ethAddressFromEthrDID(did string) (string, bool) {
	parts := strings.Split(strings.TrimSpace(did), ":")
	if len(parts) == 0 {
		return "", false
	}
	candidate := parts[len(parts)-1]
	if !common.IsHexAddress(candidate) {
		return "", false
	}
	return common.HexToAddress(candidate).Hex(), true
}

func resolveDIDEthAddressViaCAVSContext(ctx context.Context, client *http.Client, cavsURL string, did string) (string, error) {
	did = strings.TrimSpace(did)
	if did == "" {
		return "", fmt.Errorf("empty did")
	}
	if addr, ok := ethAddressFromEthrDID(did); ok {
		return addr, nil
	}
	var resp struct {
		OK         bool   `json:"ok"`
		DID        string `json:"did"`
		EthAddress string `json:"eth_address"`
	}
	if err := httpPostJSONContext(ctx, client, strings.TrimRight(cavsURL, "/")+"/identity/resolve", map[string]any{
		"did": did,
	}, &resp); err != nil {
		return "", fmt.Errorf("resolve did via cavs %q: %w", did, err)
	}
	if resolvedDID := strings.TrimSpace(resp.DID); resolvedDID != "" && resolvedDID != did {
		return "", fmt.Errorf("resolve did via cavs returned did %q for requested did %q", resolvedDID, did)
	}
	addr, err := normalizeEthAddress(resp.EthAddress)
	if err != nil {
		return "", fmt.Errorf("resolve did via cavs %q returned invalid eth_address: %w", did, err)
	}
	return addr, nil
}

func resolveDIDEthAddressViaCAVS(client *http.Client, cavsURL string, did string) (string, error) {
	return resolveDIDEthAddressViaCAVSContext(context.Background(), client, cavsURL, did)
}

func onchainAddressKey(pubkey types.OnchainPublicKey) string {
	return strings.ToLower(common.BytesToAddress(pubkey).Hex())
}

// PublicKey returns the Ethereum address bytes that libocr uses as the onchain
// identity for this oracle.
func (k *cavsOnchainKeyring) PublicKey() types.OnchainPublicKey {
	out := make([]byte, len(k.publicKey))
	copy(out, k.publicKey)
	return types.OnchainPublicKey(out)
}

// reportSigHash defines WHAT exactly is signed for a report.
//
// In OCR3 the contract verifies signatures over (configDigest, seqNr, reportBytes).
// The exact hashing scheme is verifier-dependent; this integration uses a simple
// keccak256 over concatenation, which is enough to simulate signature collection.
func reportSigHash(configDigest types.ConfigDigest, seqNr uint64, report types.Report) common.Hash {
	var seq [8]byte
	binary.BigEndian.PutUint64(seq[:], seqNr)
	payload := make([]byte, 0, len(configDigest)+len(seq)+len(report))
	payload = append(payload, configDigest[:]...)
	payload = append(payload, seq[:]...)
	payload = append(payload, report...)
	return crypto.Keccak256Hash(payload)
}

// Sign asks the oracle's local CAVS service to sign the report digest using the
// Ethereum key backing the oracle's did:ethr identity.
func (k *cavsOnchainKeyring) Sign(configDigest types.ConfigDigest, seqNr uint64, reportWithInfo ocr3types.ReportWithInfo[struct{}]) ([]byte, error) {
	h := reportSigHash(configDigest, seqNr, reportWithInfo.Report)
	var resp struct {
		SignatureHex string `json:"signatureHex"`
	}
	err := httpPostJSON(k.http, strings.TrimRight(k.cavsURL, "/")+"/message/sign", map[string]any{
		"oracleId":  k.oracleID,
		"digestHex": h.Hex(),
	}, &resp)
	if err != nil {
		return nil, err
	}
	sigHex := strings.TrimSpace(resp.SignatureHex)
	if sigHex == "" {
		return nil, fmt.Errorf("cavs /message/sign returned empty signature")
	}
	sig, err := hex.DecodeString(strings.TrimPrefix(sigHex, "0x"))
	if err != nil {
		return nil, fmt.Errorf("decode cavs signature: %w", err)
	}
	return sig, nil
}

// Verify resolves the DID associated with the signer Ethereum address and asks
// the local CAVS service to verify the signature against that did:ethr identity.
// OnChainPublicKey of the Oracle that maade the signign
func (k *cavsOnchainKeyring) Verify(pubkey types.OnchainPublicKey, configDigest types.ConfigDigest, seqNr uint64, reportWithInfo ocr3types.ReportWithInfo[struct{}], sig []byte) bool {
	if len(pubkey) != 20 {
		return false
	}
	if len(sig) == 0 {
		return false
	}
	entry, ok := k.registryByAddress[onchainAddressKey(pubkey)]
	if !ok || entry.DID == "" {
		return false
	}
	h := reportSigHash(configDigest, seqNr, reportWithInfo.Report)
	var resp struct {
		Verified bool `json:"verified"`
	}
	body := map[string]any{
		"digestHex":    h.Hex(),
		"signatureHex": "0x" + hex.EncodeToString(sig),
		"did":          entry.DID,
	}
	err := httpPostJSON(k.http, strings.TrimRight(k.cavsURL, "/")+"/message/verify", body, &resp)
	if err != nil {
		return false
	}
	return resp.Verified
}

// MaxSignatureLength stays at 65 to allow both 64-byte compact and 65-byte
// standard secp256k1 signatures from the signer backend.
func (k *cavsOnchainKeyring) MaxSignatureLength() int { return 65 }

func newCAVSOnchainKeyring(oracleID int, cavsURL string, me didRegistryEntry, registry []didRegistryEntry) (*cavsOnchainKeyring, types.Account, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	//find DID Ethereum mapped Ethereum account address
	addr, err := resolveDIDEthAddressViaCAVS(client, cavsURL, me.DID)
	if err != nil {
		return nil, "", err
	}
	publicKey, from, err := onchainPublicKeyFromAddress(addr)
	if err != nil {
		return nil, "", err
	}
	resolvedByDID := map[string]string{strings.TrimSpace(me.DID): addr}
	registryByAddress := make(map[string]didRegistryEntry, len(registry))
	for _, entry := range registry {
		entryDID := strings.TrimSpace(entry.DID)
		entryAddr, ok := resolvedByDID[entryDID]
		if !ok {
			entryAddr, err = resolveDIDEthAddressViaCAVS(client, cavsURL, entryDID)
			if err != nil {
				return nil, "", fmt.Errorf("registry oracle %d: %w", entry.OracleID, err)
			}
			resolvedByDID[entryDID] = entryAddr
		}
		key := strings.ToLower(entryAddr)
		if existing, ok := registryByAddress[key]; ok && existing.DID != entry.DID {
			return nil, "", fmt.Errorf("duplicate onchain address %s for DIDs %s and %s", key, existing.DID, entry.DID)
		}
		registryByAddress[key] = entry
	}
	return &cavsOnchainKeyring{
		oracleID:          oracleID,
		cavsURL:           cavsURL,
		did:               me.DID,
		publicKey:         append(types.OnchainPublicKey(nil), publicKey...),
		registryByAddress: registryByAddress,
		http:              client,
	}, from, nil
}

type offchainKeyring struct {
	offPriv        ed25519.PrivateKey
	cfgPriv        [32]byte
	cfgPub         [32]byte
	requestEncPriv [32]byte
	requestEncPub  [32]byte
}

// newOffchainKeyringGeneration derives an oracle's OCR offchain/config keys
// plus a separate CAVS request-encryption keypair from that oracle's seed.
//
// oracleSeed must be unique per oracle. oracleID is still mixed in for domain
// separation so the same numeric seed reused across two IDs does not collide.
func newOffchainKeyringGeneration(oracleSeed int64, oracleID int) (*offchainKeyring, error) {
	offSeed := sha256.Sum256([]byte(fmt.Sprintf("offchain|%d|%d", oracleSeed, oracleID)))
	offPriv := ed25519.NewKeyFromSeed(offSeed[:])

	cfgSeed := sha256.Sum256([]byte(fmt.Sprintf("cfg|%d|%d", oracleSeed, oracleID)))
	var cfgPriv [32]byte
	copy(cfgPriv[:], cfgSeed[:])

	cfgPrivateKey, err := ecdh.X25519().NewPrivateKey(cfgPriv[:])
	if err != nil {
		return nil, err
	}
	var cfgPubArr [32]byte
	copy(cfgPubArr[:], cfgPrivateKey.PublicKey().Bytes())

	requestEncSeed := sha256.Sum256([]byte(fmt.Sprintf("cavs-request-encryption|%d|%d", oracleSeed, oracleID)))
	var requestEncPriv [32]byte
	copy(requestEncPriv[:], requestEncSeed[:])
	requestEncPrivateKey, err := ecdh.X25519().NewPrivateKey(requestEncPriv[:])
	if err != nil {
		return nil, err
	}
	var requestEncPubArr [32]byte
	copy(requestEncPubArr[:], requestEncPrivateKey.PublicKey().Bytes())

	return &offchainKeyring{
		offPriv:        offPriv,
		cfgPriv:        cfgPriv,
		cfgPub:         cfgPubArr,
		requestEncPriv: requestEncPriv,
		requestEncPub:  requestEncPubArr,
	}, nil
}

// OffchainSign signs protocol messages (NOT reports). OCR3 uses Ed25519 for
// offchain message authentication.
func (k *offchainKeyring) OffchainSign(msg []byte) ([]byte, error) {
	return ed25519.Sign(k.offPriv, msg), nil
}

// ConfigDiffieHellman derives a shared secret used to encrypt offchain config
// values between oracles (X25519).
func (k *offchainKeyring) ConfigDiffieHellman(point [32]byte) ([32]byte, error) {
	var r [32]byte
	privateKey, err := ecdh.X25519().NewPrivateKey(k.cfgPriv[:])
	if err != nil {
		return r, err
	}
	peerKey, err := ecdh.X25519().NewPublicKey(point[:])
	if err != nil {
		return r, err
	}
	out, err := privateKey.ECDH(peerKey)
	if err != nil {
		return r, err
	}
	copy(r[:], out)
	return r, nil
}

// OffchainPublicKey returns the Ed25519 public key used for offchain message verification.
func (k *offchainKeyring) OffchainPublicKey() types.OffchainPublicKey {
	var pub types.OffchainPublicKey
	copy(pub[:], k.offPriv.Public().(ed25519.PublicKey))
	return pub
}

// ConfigEncryptionPublicKey returns the oracle's config encryption public key.
func (k *offchainKeyring) ConfigEncryptionPublicKey() types.ConfigEncryptionPublicKey {
	return k.cfgPub
}

// OraclesEncryptionKey returns the dedicated X25519 public key announced
// on-chain as the oracle's OEncryKey for Alice's 1-to-N AEncryKey wrapping. It is intentionally
// separate from OCR signing and OCR config-encryption keys.
func (k *offchainKeyring) OraclesEncryptionKey() [32]byte {
	return k.requestEncPub
}

func (k *offchainKeyring) OraclesEncryptionPrivateKey() [32]byte {
	return k.requestEncPriv
}

// pluginConfig is (part of) the OCR3 offchain config for the ReportingPlugin.
// It is broadcast to all nodes through the contract config and must be identical
// everywhere to keep the protocol deterministic.
type pluginConfig struct {
	// TrustEnabled turns on the replicated trust model and trust-weighted
	// aggregation. It must be part of the shared OCR offchain config so all
	// oracles produce identical outcome bytes.
	TrustEnabled bool `json:"trustEnabled,omitempty"`
	// TrustDeltaBps is the score distance threshold on the 0..100 trust scale used to
	// classify positive/uncertain/negative evidence relative to the aggregate.
	// Example: 10 => +/-0.10.
	TrustDeltaBps int `json:"trustDeltaBps,omitempty"`
	// TrustedBeliefMinBps and TrustedUncertaintyMaxBps define whether an oracle
	// is considered trusted for the next epoch's aggregate calculations.
	TrustedBeliefMinBps      int `json:"trustedBeliefMinBps,omitempty"`
	TrustedUncertaintyMaxBps int `json:"trustedUncertaintyMaxBps,omitempty"`

	// ObservationQuorumMode selects how many valid observations end a round.
	// See ObservationQuorum for the exact liveness/completeness trade-off.
	//   - quorumModeTwoFPlusOne (default): 2f+1, BFT-live — the round proceeds
	//     even if up to f oracles are crashed, partitioned, or maliciously slow.
	//   - quorumModeAll: N — the round waits for EVERY oracle's model response,
	//     which is what you want when the benchmark must reflect all backends,
	//     but a single unavailable node then halts every round (no liveness).
	// It is part of the shared offchain config so all nodes agree.
	ObservationQuorumMode string `json:"observationQuorumMode,omitempty"`
}

const (
	quorumModeTwoFPlusOne = "two_f_plus_one"
	quorumModeAll         = "all"
)

// normalizeQuorumMode maps user/config input to a canonical quorum mode,
// defaulting to the BFT-live 2f+1 rule for anything unrecognized or empty.
func normalizeQuorumMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case quorumModeAll, "n", "unanimity", "unanimous":
		return quorumModeAll
	case "", quorumModeTwoFPlusOne, "2f+1", "2f1", "byzantine", "bft":
		return quorumModeTwoFPlusOne
	default:
		return quorumModeTwoFPlusOne
	}
}

type ocrTimingConfig struct {
	DeltaProgress               time.Duration
	DeltaResend                 time.Duration
	DeltaInitial                time.Duration
	DeltaRound                  time.Duration
	DeltaGrace                  time.Duration
	DeltaCertifiedCommitRequest time.Duration
	DeltaStage                  time.Duration
	RMax                        uint64

	MaxDurationQuery                        time.Duration
	MaxDurationObservation                  time.Duration
	MaxDurationShouldAcceptAttestedReport   time.Duration
	MaxDurationShouldTransmitAcceptedReport time.Duration
}

func defaultOCRTimingConfig(deltaGrace time.Duration) ocrTimingConfig {
	return ocrTimingConfig{
		DeltaProgress:               6 * time.Minute,
		DeltaResend:                 2 * time.Minute,
		DeltaInitial:                5 * time.Second,
		DeltaRound:                  3 * time.Second,
		DeltaGrace:                  deltaGrace,
		DeltaCertifiedCommitRequest: 10 * time.Second,
		DeltaStage:                  10 * time.Second,
		RMax:                        5,

		MaxDurationQuery:                        30 * time.Second,
		MaxDurationObservation:                  300 * time.Second,
		MaxDurationShouldAcceptAttestedReport:   30 * time.Second,
		MaxDurationShouldTransmitAcceptedReport: 30 * time.Second,
	}
}

func (tc ocrTimingConfig) validate() error {
	if tc.DeltaProgress <= 0 {
		return fmt.Errorf("delta_progress must be > 0")
	}
	if tc.DeltaResend <= 0 {
		return fmt.Errorf("delta_resend must be > 0")
	}
	if tc.DeltaInitial <= 0 {
		return fmt.Errorf("delta_initial must be > 0")
	}
	if tc.DeltaRound < 500*time.Millisecond {
		return fmt.Errorf("delta_round must be >= 500ms")
	}
	if tc.DeltaGrace < 0 {
		return fmt.Errorf("delta_grace must be >= 0")
	}
	if tc.DeltaCertifiedCommitRequest <= 0 {
		return fmt.Errorf("delta_certified_commit_request must be > 0")
	}
	if tc.DeltaStage <= 0 {
		return fmt.Errorf("delta_stage must be > 0")
	}
	if tc.RMax == 0 {
		return fmt.Errorf("r_max must be > 0")
	}
	if tc.MaxDurationQuery <= 0 {
		return fmt.Errorf("max_dur_query must be > 0")
	}
	if tc.MaxDurationObservation <= 0 {
		return fmt.Errorf("max_dur_obs must be > 0")
	}
	if tc.MaxDurationShouldAcceptAttestedReport <= 0 {
		return fmt.Errorf("max_dur_accept must be > 0")
	}
	if tc.MaxDurationShouldTransmitAcceptedReport <= 0 {
		return fmt.Errorf("max_dur_transmit must be > 0")
	}
	if tc.DeltaProgress <= tc.MaxDurationObservation+tc.DeltaRound {
		return fmt.Errorf(
			"delta_progress (%s) must exceed max_dur_obs + delta_round (%s) to avoid premature OCR leader rotation under all-N observations",
			tc.DeltaProgress,
			tc.MaxDurationObservation+tc.DeltaRound,
		)
	}
	return nil
}

func (pc *pluginConfig) normalize() {
	// TrustDeltaBps says how far an oracle's decision-aligned score may be from
	// the final aggregate score and still count as "agreement" for trust updates.
	if pc.TrustDeltaBps <= 0 {
		// Default to 10 on the 0..100 scale, i.e. a maximum difference of 0.10.
		pc.TrustDeltaBps = 10
	}
	// Force the threshold into the valid trust range [0,100].
	pc.TrustDeltaBps = clampInt(pc.TrustDeltaBps, 0, trustScale)
	// TrustedBeliefMinBps is the minimum subjective-logic belief component `b`
	// an oracle must accumulate before we call it trusted.
	if pc.TrustedBeliefMinBps <= 0 {
		// Default to requiring at least 51 on the 0..100 trust scale.
		pc.TrustedBeliefMinBps = 51
	}
	// Force the belief threshold into the valid trust range [0,100].
	pc.TrustedBeliefMinBps = clampInt(pc.TrustedBeliefMinBps, 0, trustScale)
	// TrustedUncertaintyMaxBps is the largest subjective-logic uncertainty `u`
	// we still allow when deciding that an oracle is trusted.
	if pc.TrustedUncertaintyMaxBps <= 0 {
		// Default to allowing at most 49 on the 0..100 trust scale.
		pc.TrustedUncertaintyMaxBps = 49
	}
	// Force the uncertainty threshold into the valid trust range [0,100].
	pc.TrustedUncertaintyMaxBps = clampInt(pc.TrustedUncertaintyMaxBps, 0, trustScale)
	// Default to the BFT-live 2f+1 quorum; opt into strict all-N via config.
	pc.ObservationQuorumMode = normalizeQuorumMode(pc.ObservationQuorumMode)
}

// cavsPluginFactory implements ocr3types.ReportingPluginFactory.
//
// libocr calls NewReportingPlugin once per oracle process (and potentially again
// on restart). The plugin contains your application logic for Query/Observation/
// Outcome/Reports.
type cavsPluginFactory struct {
	queueURL           string
	localQueue         *requestQueue
	requestSource      string
	skillExtractorURL  string
	competenceMode     string
	simulationMode     bool
	observationTimeout time.Duration
	requestImportWait  time.Duration
	logObservations    bool
	postObservations   bool
	trustDIDs          []string
	metrics            *metricRecorder
	reasonEmbedder     reasonEmbedder
}

// NewReportingPlugin constructs the per-oracle plugin instance and declares
// plugin "limits" (max byte sizes) used by libocr for validation/rate limiting.
func (f cavsPluginFactory) NewReportingPlugin(_ context.Context, cfg ocr3types.ReportingPluginConfig) (ocr3types.ReportingPlugin[struct{}], ocr3types.ReportingPluginInfo, error) {
	pc := pluginConfig{}
	if len(cfg.OffchainConfig) != 0 {
		_ = json.Unmarshal(cfg.OffchainConfig, &pc)
	}
	pc.normalize()
	reasonEmbedder := f.reasonEmbedder
	if reasonEmbedder == nil {
		reasonEmbedder = defaultMiniLMReasonEmbedder
	}
	// Phase-isolation simulation emits one fixed reason on every oracle, so
	// medianReason returns before embedding. Initializing and warming ONNX here
	// would allocate a model and native thread pools that the simulation can
	// never use, perturbing the very CPU/resource measurements it is intended
	// to isolate.
	if !f.simulationMode {
		if err := warmReasonEmbedder(reasonEmbedder); err != nil {
			return nil, ocr3types.ReportingPluginInfo{}, err
		}
	}
	p := &cavsPlugin{
		cfg:                cfg,
		pc:                 pc,
		queueURL:           strings.TrimRight(f.queueURL, "/"),
		localQueue:         f.localQueue,
		requestSource:      strings.TrimSpace(f.requestSource),
		skillExtractorURL:  strings.TrimRight(f.skillExtractorURL, "/"),
		competenceMode:     strings.TrimSpace(f.competenceMode),
		simulationMode:     f.simulationMode,
		observationTimeout: f.observationTimeout,
		requestImportWait:  f.requestImportWait,
		logObservations:    f.logObservations,
		postObservations:   f.postObservations,
		trustDIDs:          append([]string(nil), f.trustDIDs...),
		metrics:            f.metrics,
		reasonEmbedder:     reasonEmbedder,
		http:               newObservationHTTPClient(f.observationTimeout),
	}
	info := ocr3types.ReportingPluginInfo{
		Name: "gpt-comp-checker-vector-median-trust",
		Limits: ocr3types.ReportingPluginLimits{
			MaxQueryLength:       64 * 1024,
			MaxObservationLength: 256 * 1024,
			MaxOutcomeLength:     512 * 1024,
			MaxReportLength:      512 * 1024,
			MaxReportCount:       1,
		},
	}
	return p, info, nil
}

// cavsPlugin is the core "application logic" that OCR3 runs.
//
// Note: all methods are on the protocol's critical path. Keep them fast and
// deterministic; any non-determinism can cause signature verification failures.
type cavsPlugin struct {
	cfg ocr3types.ReportingPluginConfig
	pc  pluginConfig

	queueURL           string
	localQueue         *requestQueue
	requestSource      string
	skillExtractorURL  string
	competenceMode     string
	simulationMode     bool
	observationTimeout time.Duration
	requestImportWait  time.Duration
	logObservations    bool
	postObservations   bool
	trustDIDs          []string
	http               *http.Client
	metrics            *metricRecorder
	reasonEmbedder     reasonEmbedder
}

func (p *cavsPlugin) getCurrentRequest(ctx context.Context) (queryPayload, bool, error) {
	return getCurrentRequest(ctx, p.http, p.queueURL, p.localQueue)
}

func (p *cavsPlugin) getStoredRequest(ctx context.Context, requestID string) (queryPayload, bool, error) {
	return getStoredRequest(ctx, p.http, p.queueURL, p.localQueue, requestID)
}

func (p *cavsPlugin) waitForStoredRequest(ctx context.Context, requestID string) (queryPayload, bool, error) {
	if p.localQueue != nil {
		return p.localQueue.waitForStoredRequest(ctx, requestID)
	}
	return p.getStoredRequest(ctx, requestID)
}

func (p *cavsPlugin) markRequestComplete(ctx context.Context, requestID string) error {
	return postCompletion(ctx, p.http, p.queueURL, p.localQueue, requestID)
}

type slOpinion struct {
	// b = belief that the oracle tends to agree with the aggregate outcome.
	b float64
	// d = disbelief that the oracle tends to agree with the aggregate outcome.
	d float64
	// u = remaining uncertainty because we do not yet have enough evidence.
	u float64
}

// slConsensus merges two subjective-logic opinions into one.
//
// In this codebase we call it per oracle:
// - `old` is that oracle's current running trust opinion carried from prior rounds
// - `new` is that oracle's new epoch opinion derived from fresh pos/neg/unc evidence
// The result is the updated running trust opinion for that same oracle.
func slConsensus(old, new slOpinion) slOpinion {
	// `old.u` is the uncertainty already present in the past running opinion.
	// `new.u` is the uncertainty in the newly computed epoch opinion.
	// `old.u*new.u` is the overlap between those two uncertainties, subtracted so the
	// shared uncertain mass is not counted twice.
	// Example: if `old.u=0.30` and `new.u=0.40`, then `old.u*new.u=0.12`, so
	// `xi = 0.30 + 0.40 - 0.12 = 0.58`.
	// `xi` is the uncertainty coefficient for this merge, i.e. the
	// subjective-logic normalization denominator computed from the two
	// uncertainty terms.
	xi := old.u + new.u - old.u*new.u
	if xi <= 1e-12 {
		// Degenerate case: both opinions have almost no uncertainty left, so the
		// normal consensus denominator becomes numerically unstable. Fall back to
		// averaging belief/disbelief and renormalizing.
		// Example: if `old=(b=0.80,d=0.20,u=0.00)` and `new=(b=0.60,d=0.40,u=0.00)`,
		// then `xi=0`, so we average belief/disbelief to get `b=0.70`, `d=0.30`,
		// and return `(b=0.70,d=0.30,u=0.00)`.
		b := 0.5 * (old.b + new.b)
		d := 0.5 * (old.d + new.d)
		sum := b + d
		if sum <= 1e-12 {
			// If even belief+disbelief collapse to zero, treat the result as fully uncertain.
			return slOpinion{b: 0, d: 0, u: 1}
		}
		return slOpinion{b: b / sum, d: d / sum, u: 0}
	}
	// Normal case: merge the two opinions by weighting each side's belief and
	// disbelief by the other side's uncertainty, then normalize by `xi`.
	// Example: if `old=(b=0.50,d=0.20,u=0.30)` and `new=(b=0.20,d=0.40,u=0.40)`,
	// then `xi=0.58`, so the merged result is approximately
	// `(b=0.4483,d=0.3448,u=0.2069)`.
	return slOpinion{
		b: (old.b*new.u + new.b*old.u) / xi,
		d: (old.d*new.u + new.d*old.u) / xi,
		u: (old.u * new.u) / xi,
	}
}

// opinionFromBps converts the persisted trust-scale representation `(B,D,U)`
// back into normalized floating-point subjective-logic components `(b,d,u)`.
// We divide by the total sum at the end so the returned opinion always satisfies
// the subjective-logic invariant `b + d + u = 1`, even if the stored values
// are slightly off because of rounding or malformed input.
func opinionFromBps(o trustOpinionBps) slOpinion {
	b := float64(o.B) / float64(trustScale)
	d := float64(o.D) / float64(trustScale)
	u := float64(o.U) / float64(trustScale)
	sum := b + d + u
	if sum <= 1e-12 {
		// Invalid/empty input should degrade to full uncertainty instead of panicking.
		return slOpinion{b: 0, d: 0, u: 1}
	}
	// Normalize the three components so they add up to exactly 1.
	return slOpinion{b: b / sum, d: d / sum, u: u / sum}
}

// opinionToBps converts a floating-point subjective-logic opinion into the
// persisted trust-scale form used in OCR outcomes.
//
// The output must always satisfy:
// - each component is in [0,100]
// - B + D + U = 100
func opinionToBps(o slOpinion) trustOpinionBps {
	// First bound each component into the valid probability range.
	b := math.Max(0, math.Min(1, o.b))
	d := math.Max(0, math.Min(1, o.d))
	u := math.Max(0, math.Min(1, o.u))
	sum := b + d + u
	if sum <= 1e-12 {
		// No usable signal: store the neutral "fully uncertain" opinion.
		return trustOpinionBps{B: 0, D: 0, U: trustScale}
	}
	// Renormalize so rounding starts from a proper probability triple.
	b /= sum
	d /= sum
	u /= sum

	// Round each component onto the discrete 0..100 trust scale.
	bBps := clampInt(int(math.Round(b*float64(trustScale))), 0, trustScale)
	dBps := clampInt(int(math.Round(d*float64(trustScale))), 0, trustScale)
	// Let uncertainty absorb the remainder so the total stays exactly 100.
	uBps := trustScale - bBps - dBps
	if uBps < 0 {
		// Rare rounding edge case: if B and D overshoot 100 together, shrink the
		// larger one so the triple remains valid and set U to zero.
		if bBps >= dBps {
			bBps = trustScale - dBps
		} else {
			dBps = trustScale - bBps
		}
		uBps = 0
	}
	return trustOpinionBps{B: uint16(bBps), D: uint16(dBps), U: uint16(uBps)}
}

// evidenceToOpinion turns raw epoch evidence counts into one subjective-logic
// opinion by simple normalization:
// - positive evidence -> belief
// - negative evidence -> disbelief
// - uncertain evidence -> uncertainty
func evidenceToOpinion(e trustEvidenceCounts) slOpinion {
	total := uint64(e.Pos) + uint64(e.Neg) + uint64(e.Unc)
	if total == 0 {
		// No evidence means we learned nothing, so stay fully uncertain.
		return slOpinion{b: 0, d: 0, u: 1}
	}
	den := float64(total)
	return slOpinion{
		b: float64(e.Pos) / den,
		d: float64(e.Neg) / den,
		u: float64(e.Unc) / den,
	}
}

// initTrustEvidence allocates one `(pos,neg,unc)` bucket per oracle for the
// current request/epoch accumulation window.
func initTrustEvidence(n int) []trustEvidenceCounts {
	return make([]trustEvidenceCounts, n)
}

func normalizeTrustDIDs(n int, dids []string) []string {
	out := make([]string, n)
	for i := 0; i < n; i++ {
		if i < len(dids) {
			out[i] = strings.TrimSpace(dids[i])
		}
	}
	return out
}

// initTrust builds the initial replicated trust state for `n` oracles.
// `n` is the number of oracle identities in the DON, so we allocate one trust
// opinion and one pending evidence bucket per oracle.
// Trust epochs are fixed at `fixedTrustEpochLen`, so this initializer no longer
// takes an epoch-length parameter.
func initTrust(n int, currentDIDs []string) *trustPayload {
	currentDIDs = normalizeTrustDIDs(n, currentDIDs)
	// Running holds the current long-lived trust opinion for each oracle.
	running := make([]trustOpinionBps, n)
	for i := 0; i < n; i++ {
		// Start every oracle as fully uncertain: no belief, no disbelief,
		// all mass in uncertainty.
		running[i] = trustOpinionBps{B: 0, D: 0, U: trustScale}
	}
	return &trustPayload{
		// DIDs pins each trust slot to the oracle DID currently in that position.
		DIDs: currentDIDs,
		// EpochLen fixes the size of the accumulation window before a trust update.
		EpochLen: fixedTrustEpochLen,
		// Epoch starts at 1 so the first completed window becomes epoch 1, not 0.
		Epoch: 1,
		// Running stores one persisted trust opinion per oracle.
		Running: running,
		// Pending stores the current window's pos/neg/unc evidence counts per oracle.
		Pending: initTrustEvidence(n),
		// No requests have been processed in the current epoch yet.
		RequestsInEpoch: 0,
	}
}

func remapTrustByDID(prev *trustPayload, currentDIDs []string) (*trustPayload, bool) {
	if len(prev.DIDs) != len(prev.Running) {
		return nil, false
	}
	currentDIDs = normalizeTrustDIDs(len(currentDIDs), currentDIDs)
	remapped := initTrust(len(currentDIDs), currentDIDs)
	remapped.Epoch = prev.Epoch
	if remapped.Epoch == 0 {
		remapped.Epoch = 1
	}
	oldIndexByDID := make(map[string]int, len(prev.DIDs))
	for i, did := range prev.DIDs {
		did = strings.TrimSpace(did)
		if did == "" {
			continue
		}
		if _, exists := oldIndexByDID[did]; !exists {
			oldIndexByDID[did] = i
		}
	}
	matched := 0
	pendingAligned := len(prev.Pending) == len(prev.Running)
	if pendingAligned {
		remapped.RequestsInEpoch = prev.RequestsInEpoch
	}
	for i, did := range currentDIDs {
		if oldIdx, ok := oldIndexByDID[did]; ok {
			remapped.Running[i] = prev.Running[oldIdx]
			if pendingAligned {
				remapped.Pending[i] = prev.Pending[oldIdx]
			}
			matched++
		}
	}
	if !pendingAligned || remapped.RequestsInEpoch >= remapped.EpochLen {
		remapped.Pending = initTrustEvidence(len(currentDIDs))
		remapped.RequestsInEpoch = 0
	}
	return remapped, matched > 0
}

// decodePreviousTrust extracts the replicated trust state from the previous OCR
// outcome and repairs/reset it if the payload is missing or incompatible with
// the current runtime expectations.
// `prev` is the raw previous outcome bytes from libocr.
// `n` is the number of oracles expected in the current DON, used to validate
// the per-oracle arrays stored in the trust payload.
func decodePreviousTrust(prev ocr3types.Outcome, n int, currentDIDs []string) *trustPayload {
	currentDIDs = normalizeTrustDIDs(n, currentDIDs)
	if len(prev) == 0 {
		// First round or no previous outcome: start from a fresh fully-uncertain state.
		return initTrust(n, currentDIDs)
	}
	var out outcomePayload
	if err := json.Unmarshal(prev, &out); err != nil || out.Trust == nil {
		// If the previous outcome cannot be parsed or carried no trust payload,
		// fall back to a fresh trust state instead of failing the round.
		return initTrust(n, currentDIDs)
	}
	t := out.Trust
	if t.EpochLen != fixedTrustEpochLen {
		// If the stored trust state was produced with a different epoch model,
		// discard it and restart cleanly.
		return initTrust(n, currentDIDs)
	}
	if len(t.DIDs) == len(t.Running) {
		// New-format trust payloads carry the previous DID ordering, so remap the
		// trust slots onto the current DID registry instead of assuming indices
		// still mean the same oracle.
		remapped, ok := remapTrustByDID(t, currentDIDs)
		if !ok {
			return initTrust(n, currentDIDs)
		}
		t = remapped
	} else if len(t.Running) != n {
		// Older payloads without DID metadata can only be reused if the DON size
		// still matches the current runtime exactly.
		return initTrust(n, currentDIDs)
	} else {
		// Backward compatibility for older payloads: keep the old positional
		// mapping and attach the current DID order so future rounds can remap.
		t.DIDs = currentDIDs
		if t.Epoch == 0 {
			t.Epoch = 1
		}
	}
	if len(t.Pending) != n {
		// Repair malformed pending evidence arrays by recreating one bucket per oracle.
		t.Pending = initTrustEvidence(n)
		t.RequestsInEpoch = 0
	}
	if t.RequestsInEpoch >= t.EpochLen {
		// If the carried counter is already past the epoch boundary, reset the
		// pending window so we do not merge stale evidence twice.
		t.Pending = initTrustEvidence(n)
		t.RequestsInEpoch = 0
	}
	t.DIDs = currentDIDs
	// The trust payload is present and structurally valid enough to keep using.
	return t
}

// computeTrusted derives the boolean "trusted set" view from the running
// subjective-logic opinions.
// An oracle is marked trusted only if:
// - its belief component `B` is at least `beliefMinBps`
// - its uncertainty component `U` is at most `uncertaintyMaxBps`
// Both thresholds are expressed on the same 0..100 trust scale as `running`.
func computeTrusted(running []trustOpinionBps, beliefMinBps int, uncertaintyMaxBps int) []bool {
	out := make([]bool, len(running))
	for i := 0; i < len(running); i++ {
		// Trusted means "enough belief and not too much remaining uncertainty".
		out[i] = int(running[i].B) >= beliefMinBps && int(running[i].U) <= uncertaintyMaxBps
	}
	return out
}

// trustWeightBps maps a subjective-logic opinion to a single "contribution weight"
// on the 0..100 trust scale, used for trust-weighted aggregation.
//
// We use the standard subjective-logic expectation value:
//
//	E = b + a*u, with base rate a=0.5
//
// and return E on the trust scale (0..100).
//
// A fully distrusted oracle (b=0,d=1,u=0) yields weight 0.
// A fully uncertain oracle (b=0,d=0,u=1) yields weight 50 (neutral).
func trustWeightBps(o trustOpinionBps) uint32 {
	return uint32(o.B) + uint32(o.U)/2
}

type weightedScore struct {
	Score  float64
	Weight uint32
	Oracle commontypes.OracleID
}

type obsResult struct {
	observer commontypes.OracleID
	comp     bool
	conf     float64
	reason   string
	weight   uint32
}

// weightedMean returns the trust-weighted arithmetic mean of the scores.
// If all weights are zero, as in the evaluated configuration where optional
// trust weighting is disabled, it returns the unweighted arithmetic mean.
func weightedMean(in []weightedScore) float64 {
	if len(in) == 0 {
		return 0
	}
	values := append([]weightedScore(nil), in...)
	sort.Slice(values, func(i, j int) bool {
		if values[i].Score == values[j].Score {
			return values[i].Oracle < values[j].Oracle
		}
		return values[i].Score < values[j].Score
	})
	var weightedSum float64
	var totalWeight uint64
	for _, x := range values {
		weightedSum += x.Score * float64(x.Weight)
		totalWeight += uint64(x.Weight)
	}
	if totalWeight == 0 {
		var sum float64
		for _, x := range values {
			sum += x.Score
		}
		return sum / float64(len(values))
	}
	return weightedSum / float64(totalWeight)
}

type reasonEmbedder interface {
	EmbedReasons(reasons []string) ([][]float32, error)
}

type miniLMReasonEmbedder struct {
	runtimePath string
	modelPath   string
	once        sync.Once
	model       *minilm.Model
	initErr     error
	mu          sync.Mutex
}

func newMiniLMReasonEmbedder(runtimePath, modelPath string) *miniLMReasonEmbedder {
	return &miniLMReasonEmbedder{
		runtimePath: strings.TrimSpace(runtimePath),
		modelPath:   strings.TrimSpace(modelPath),
	}
}

func (e *miniLMReasonEmbedder) init() error {
	e.once.Do(func() {
		var opts []minilm.ModelOption
		if e.runtimePath != "" {
			opts = append(opts, minilm.WithRuntimePath(e.runtimePath))
		}
		if e.modelPath != "" {
			opts = append(opts, minilm.WithModelPath(e.modelPath))
		}
		e.model, e.initErr = minilm.NewModel(opts...)
	})
	return e.initErr
}

func (e *miniLMReasonEmbedder) EmbedReasons(reasons []string) ([][]float32, error) {
	if len(reasons) == 0 {
		return nil, nil
	}
	if err := e.init(); err != nil {
		return nil, fmt.Errorf("%w: %v", errReasonEmbeddingUnavailable, err)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.model.ComputeBatch(reasons, false)
}

func warmReasonEmbedder(embedder reasonEmbedder) error {
	ml, ok := embedder.(*miniLMReasonEmbedder)
	if !ok || ml == nil {
		return nil
	}
	if err := ml.init(); err != nil {
		return fmt.Errorf("init MiniLM reason embedder: %w", err)
	}
	embeddings, err := ml.EmbedReasons([]string{"MiniLM warmup", "MiniLM verification"})
	if err != nil {
		return fmt.Errorf("verify MiniLM reason embedder: %w", err)
	}
	if len(embeddings) != 2 {
		return fmt.Errorf("verify MiniLM reason embedder: got %d embeddings, want 2", len(embeddings))
	}
	for i, emb := range embeddings {
		if len(emb) == 0 {
			return fmt.Errorf("verify MiniLM reason embedder: embedding %d is empty", i)
		}
	}
	fmt.Printf("reason embedding ready dims=%d runtime=%s model=%s\n", len(embeddings[0]), strings.TrimSpace(ml.runtimePath), strings.TrimSpace(ml.modelPath))
	return nil
}

func normalizeMedianReason(reason string) string {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return "no reason provided"
	}
	return reason
}

func isTrivialMedianReason(reason string) bool {
	switch strings.ToLower(strings.TrimSpace(reason)) {
	case "", "no reason provided", "verification failed", "request not received":
		return true
	default:
		return false
	}
}

// quantizeReasonEmbedding snaps every coordinate of one embedding onto the fixed
// integer grid defined by reasonEmbeddingQuantizationScale. The returned values
// are integer-valued float32s (still in grid units), which stay exactly
// representable (|value| well under 2^24) so all later float math is exact and
// platform-independent. This is the single point where non-deterministic ONNX
// float output is collapsed to a canonical, node-agnostic representation.
func quantizeReasonEmbedding(emb []float32) []float32 {
	out := make([]float32, len(emb))
	for i, v := range emb {
		out[i] = float32(math.Round(float64(v) * reasonEmbeddingQuantizationScale))
	}
	return out
}

func quantizeReasonEmbeddings(embeddings [][]float32) [][]float32 {
	out := make([][]float32, len(embeddings))
	for i, emb := range embeddings {
		out[i] = quantizeReasonEmbedding(emb)
	}
	return out
}

func euclideanDistance(a, b []float32) (float64, error) {
	if len(a) != len(b) {
		return 0, fmt.Errorf("reason embedding dimension mismatch: %d != %d", len(a), len(b))
	}
	sum := 0.0
	for i := range a {
		d := float64(a[i]) - float64(b[i])
		sum += d * d
	}
	return math.Sqrt(sum), nil
}

func geometricMedianEmbedding(embeddings [][]float32) ([]float32, error) {
	if len(embeddings) == 0 {
		return nil, nil
	}
	dims := len(embeddings[0])
	if dims == 0 {
		return nil, fmt.Errorf("empty reason embedding")
	}
	for _, emb := range embeddings {
		if len(emb) != dims {
			return nil, fmt.Errorf("inconsistent reason embedding dimensions: got %d, want %d", len(emb), dims)
		}
	}
	if len(embeddings) == 1 {
		return append([]float32(nil), embeddings[0]...), nil
	}

	// The median graph paper computes the vector-domain median as the
	// Euclidean/geometric median and approximates it with Weiszfeld's algorithm.
	// We do the same for reason embeddings, then pick the nearest observed reason.
	current := make([]float32, dims)
	for _, emb := range embeddings {
		for dim, v := range emb {
			current[dim] += v / float32(len(embeddings))
		}
	}

	for iter := 0; iter < geometricMedianMaxIterations; iter++ {
		next := make([]float32, dims)
		denom := 0.0
		for _, emb := range embeddings {
			dist, err := euclideanDistance(current, emb)
			if err != nil {
				return nil, err
			}
			if dist <= geometricMedianTolerance {
				return append([]float32(nil), emb...), nil
			}
			weight := 1.0 / dist
			denom += weight
			for dim, v := range emb {
				next[dim] += float32(float64(v) * weight)
			}
		}
		if denom == 0 {
			return current, nil
		}
		for dim := range next {
			next[dim] = float32(float64(next[dim]) / denom)
		}
		delta, err := euclideanDistance(current, next)
		if err != nil {
			return nil, err
		}
		current = next
		if delta <= geometricMedianTolerance {
			break
		}
	}
	return current, nil
}

func reasonEmbeddingDistance(a, b []float32) (float64, error) {
	if len(a) != len(b) {
		return 0, fmt.Errorf("reason embedding dimension mismatch: %d != %d", len(a), len(b))
	}
	sum := 0.0
	for i := range a {
		d := float64(a[i]) - float64(b[i])
		sum += d * d
	}
	return sum, nil
}

func medianReason(results []obsResult, embedder reasonEmbedder) (string, error) {
	if len(results) == 0 {
		return "no reason provided", nil
	}
	if embedder == nil {
		return "", fmt.Errorf("reason embedder is not configured")
	}
	reasons := make([]string, len(results))
	uniqueReasons := make(map[string]struct{}, len(results))
	allTrivial := true
	for i, r := range results {
		reasons[i] = normalizeMedianReason(r.reason)
		uniqueReasons[reasons[i]] = struct{}{}
		if !isTrivialMedianReason(reasons[i]) {
			allTrivial = false
		}
	}
	if len(uniqueReasons) == 1 || allTrivial {
		return reasons[0], nil
	}
	rawEmbeddings, err := embedder.EmbedReasons(reasons)
	if err != nil {
		return "", fmt.Errorf("embed reasons: %w", err)
	}
	if len(rawEmbeddings) != len(reasons) {
		return "", fmt.Errorf("embed reasons returned %d embeddings for %d reasons", len(rawEmbeddings), len(reasons))
	}
	// Snap the raw ONNX output onto the shared integer grid before ANY distance
	// or median math, so the selected reason is identical on every honest node.
	embeddings := quantizeReasonEmbeddings(rawEmbeddings)
	medianEmb, err := geometricMedianEmbedding(embeddings)
	if err != nil {
		return "", err
	}
	bestReason := reasons[0]
	bestDistance := math.MaxFloat64
	bestOracle := results[0].observer
	for i, r := range results {
		distance, err := reasonEmbeddingDistance(embeddings[i], medianEmb)
		if err != nil {
			return "", err
		}
		if distance < bestDistance || (distance == bestDistance && r.observer < bestOracle) {
			bestDistance = distance
			bestOracle = r.observer
			bestReason = reasons[i]
		}
	}
	return bestReason, nil
}

func fallbackReason(results []obsResult, targetConfidence float64) string {
	if len(results) == 0 {
		return "no reason provided"
	}
	bestReason := normalizeMedianReason(results[0].reason)
	bestDistance := math.Abs(results[0].conf - targetConfidence)
	bestOracle := results[0].observer
	for i := 1; i < len(results); i++ {
		reason := normalizeMedianReason(results[i].reason)
		distance := math.Abs(results[i].conf - targetConfidence)
		if distance < bestDistance || (distance == bestDistance && results[i].observer < bestOracle) {
			bestDistance = distance
			bestOracle = results[i].observer
			bestReason = reason
		}
	}
	return bestReason
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func absInt(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

func envInt64(name string) (int64, bool, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return 0, false, nil
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, false, fmt.Errorf("parse %s=%q: %w", name, raw, err)
	}
	return v, true, nil
}

func envBool(name string) (bool, bool, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return false, false, nil
	}
	v, err := strconv.ParseBool(raw)
	if err != nil {
		return false, true, fmt.Errorf("parse %s=%q: %w", name, raw, err)
	}
	return v, true, nil
}

func envString(name string) (string, bool) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return "", false
	}
	return raw, true
}

func parseInt64CSV(raw string, n int) ([]int64, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("empty seed list")
	}
	parts := strings.Split(raw, ",")
	if n > 0 && len(parts) != n {
		return nil, fmt.Errorf("expected %d seeds, got %d", n, len(parts))
	}
	out := make([]int64, 0, len(parts))
	for i, part := range parts {
		token := strings.TrimSpace(part)
		if token == "" {
			return nil, fmt.Errorf("seed %d is empty", i)
		}
		v, err := strconv.ParseInt(token, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("parse seed %d %q: %w", i, token, err)
		}
		out = append(out, v)
	}
	return out, nil
}

func validateDistinctInt64s(name string, vals []int64) error {
	seen := make(map[int64]int, len(vals))
	for i, v := range vals {
		if prev, ok := seen[v]; ok {
			return fmt.Errorf("%s values must be distinct: index %d duplicates index %d (value=%d)", name, i, prev, v)
		}
		seen[v] = i
	}
	return nil
}

func flagWasSet(name string) bool {
	set := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == name {
			set = true
		}
	})
	return set
}

func decisionScoreBps(comp bool, conf float64) int {
	c := conf
	if c < 0 {
		c = 0
	}
	if c > 1 {
		c = 1
	}
	if !comp {
		c = 1 - c
	}
	return clampInt(int(math.Round(c*float64(trustScale))), 0, trustScale)
}

func mergeTrustEvidence(dst []trustEvidenceCounts, src []trustEvidenceCounts) {
	for i := 0; i < len(dst) && i < len(src); i++ {
		dst[i].Pos += src[i].Pos
		dst[i].Neg += src[i].Neg
		dst[i].Unc += src[i].Unc
	}
}

const metricFlushInterval = 2 * time.Second

type metricRecorder struct {
	oracleID commontypes.OracleID
	backend  string
	modelID  string
	path     string

	// mu guards only the in-memory pending buffer, so appending a row from the
	// OCR hot path is a cheap slice append and never touches the disk.
	mu      sync.Mutex
	pending [][]string

	// writeMu serializes the (comparatively slow) disk writes done by flush,
	// which run off the hot path on a ticker and at shutdown.
	writeMu sync.Mutex

	startOnce sync.Once
	stopOnce  sync.Once
	stopFlush chan struct{}
	flushDone chan struct{}
}

func newMetricRecorder(oracleID commontypes.OracleID, backend string, modelID string, metricsDir string) *metricRecorder {
	metricsDir = strings.TrimSpace(metricsDir)
	backend = strings.TrimSpace(backend)
	if backend == "" {
		backend = "default"
	}
	modelID = strings.TrimSpace(modelID)
	if modelID == "" {
		modelID = backend
	}
	r := &metricRecorder{oracleID: oracleID, backend: backend, modelID: modelID}
	if metricsDir == "" {
		return r
	}
	r.path = filepath.Join(metricsDir, fmt.Sprintf("oracle_%d_metrics.csv", oracleID))
	return r
}

// startFlusher launches the background flusher that drains buffered metric rows
// to disk on a ticker. It is idempotent and a no-op when CSV metrics are off.
func (r *metricRecorder) startFlusher() {
	if r == nil || strings.TrimSpace(r.path) == "" {
		return
	}
	r.startOnce.Do(func() {
		r.stopFlush = make(chan struct{})
		r.flushDone = make(chan struct{})
		go func() {
			defer close(r.flushDone)
			ticker := time.NewTicker(metricFlushInterval)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
					r.flush()
				case <-r.stopFlush:
					r.flush()
					return
				}
			}
		}()
	})
}

// stop drains any remaining buffered rows and shuts the flusher down. Safe to
// call even if startFlusher was never called (it flushes synchronously then).
func (r *metricRecorder) stop() {
	if r == nil || strings.TrimSpace(r.path) == "" {
		return
	}
	r.stopOnce.Do(func() {
		if r.stopFlush == nil {
			r.flush()
			return
		}
		close(r.stopFlush)
		<-r.flushDone
	})
}

func (r *metricRecorder) record(phase string, seqNr uint64, observations int, start time.Time) {
	if r == nil {
		return
	}
	duration := time.Since(start)
	r.recordDuration(phase, seqNr, observations, duration)
}

func (r *metricRecorder) recordDuration(phase string, seqNr uint64, observations int, duration time.Duration) {
	if r == nil {
		return
	}
	fmt.Printf("[METRIC-OCR] Phase: %s | Oracle: %d | Backend: %s | Model: %s | SeqNr: %d | Observations: %d | Time: %s\n",
		phase, r.oracleID, r.backend, r.modelID, seqNr, observations, duration.String())
	r.appendCSV(phase, seqNr, observations, duration)
}

func (r *metricRecorder) recordLeader(phase string, seqNr uint64, start time.Time) {
	if r == nil {
		return
	}
	duration := time.Since(start)
	fmt.Printf("[METRIC-OCR] Phase: %s | Leader Oracle: %d | Backend: %s | Model: %s | SeqNr: %d | Time: %s\n", phase, r.oracleID, r.backend, r.modelID, seqNr, duration.String())
	r.appendCSV(phase, seqNr, 0, duration)
}

// appendCSV buffers one metric row in memory. The event timestamp is captured
// here (not at flush time) so the recorded time still reflects when the phase
// completed. No disk I/O happens on this path.
func (r *metricRecorder) appendCSV(phase string, seqNr uint64, observations int, duration time.Duration) {
	if strings.TrimSpace(r.path) == "" {
		return
	}
	row := []string{
		time.Now().UTC().Format(time.RFC3339Nano),
		strconv.Itoa(int(r.oracleID)),
		r.backend,
		r.modelID,
		phase,
		strconv.FormatUint(seqNr, 10),
		strconv.Itoa(observations),
		strconv.FormatInt(duration.Nanoseconds(), 10),
		duration.String(),
	}
	r.mu.Lock()
	r.pending = append(r.pending, row)
	r.mu.Unlock()
}

// flush writes all buffered rows to disk. It snapshots the buffer under mu
// (fast) and does the actual file I/O under writeMu (off the hot path), so a
// slow disk never blocks the OCR phases that are appending rows.
func (r *metricRecorder) flush() {
	if strings.TrimSpace(r.path) == "" {
		return
	}
	r.mu.Lock()
	rows := r.pending
	r.pending = nil
	r.mu.Unlock()
	if len(rows) == 0 {
		return
	}

	r.writeMu.Lock()
	defer r.writeMu.Unlock()

	if err := os.MkdirAll(filepath.Dir(r.path), 0o755); err != nil {
		fmt.Printf("metric csv mkdir error path=%s err=%v\n", r.path, err)
		r.requeue(rows)
		return
	}
	f, err := os.OpenFile(r.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		fmt.Printf("metric csv open error path=%s err=%v\n", r.path, err)
		r.requeue(rows)
		return
	}
	defer func() { _ = f.Close() }()

	info, err := f.Stat()
	if err != nil {
		fmt.Printf("metric csv stat error path=%s err=%v\n", r.path, err)
		r.requeue(rows)
		return
	}
	w := csv.NewWriter(f)
	if info.Size() == 0 {
		if err := w.Write([]string{"time", "oracle", "backend", "model_id", "phase", "seqNr", "observations", "duration_ns", "duration"}); err != nil {
			fmt.Printf("metric csv header error path=%s err=%v\n", r.path, err)
			r.requeue(rows)
			return
		}
	}
	for _, row := range rows {
		if err := w.Write(row); err != nil {
			fmt.Printf("metric csv write error path=%s err=%v\n", r.path, err)
			r.requeue(rows)
			return
		}
	}
	w.Flush()
	if err := w.Error(); err != nil {
		fmt.Printf("metric csv flush error path=%s err=%v\n", r.path, err)
		r.requeue(rows)
	}
}

// requeue puts rows back at the front of the buffer after a failed flush so a
// transient disk error does not silently drop metrics.
func (r *metricRecorder) requeue(rows [][]string) {
	r.mu.Lock()
	r.pending = append(rows, r.pending...)
	r.mu.Unlock()
}

func timingValueNs(timings map[string]any, nsKey string, msKey string) (time.Duration, bool) {
	if timings == nil {
		return 0, false
	}
	if raw, ok := timings[nsKey]; ok {
		switch v := raw.(type) {
		case float64:
			if v > 0 {
				return time.Duration(v), true
			}
		case string:
			n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
			if err == nil && n > 0 {
				return time.Duration(n), true
			}
		}
	}
	if raw, ok := timings[msKey]; ok {
		switch v := raw.(type) {
		case float64:
			if v > 0 {
				return time.Duration(v * float64(time.Millisecond)), true
			}
		case string:
			n, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
			if err == nil && n > 0 {
				return time.Duration(n * float64(time.Millisecond)), true
			}
		}
	}
	return 0, false
}

func (r *metricRecorder) recordCAVSObservationTimings(seqNr uint64, responsePayload map[string]any) {
	raw, ok := responsePayload["timings"].(map[string]any)
	if !ok {
		return
	}
	if d, ok := timingValueNs(raw, "verify_vcs_ns", "verify_vcs_ms"); ok {
		r.recordDuration("CAVS_VERIFY_VCS", seqNr, 0, d)
	}
	if d, ok := timingValueNs(raw, "ai_competence_ns", "ai_competence_ms"); ok {
		r.recordDuration("CAVS_AI_COMPETENCE", seqNr, 0, d)
	}
}

func requestProcessingBoundary(r *metricRecorder, phase string, oracleID commontypes.OracleID, seqNr uint64, requestID string) func() {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return func() {}
	}
	backend := "default"
	modelID := "default"
	if r != nil && strings.TrimSpace(r.backend) != "" {
		backend = strings.TrimSpace(r.backend)
		modelID = strings.TrimSpace(r.modelID)
	}
	fmt.Printf("[REQUEST-OCR] processing request ID=%s | Phase: %s | Oracle: %d | Backend: %s | Model: %s | SeqNr: %d\n",
		requestID, phase, oracleID, backend, modelID, seqNr)
	// Do not charge synchronous container stdout/backpressure at phase entry to
	// the phase itself. The end timestamp is likewise captured before its log.
	start := time.Now()
	return func() {
		elapsed := time.Since(start)
		fmt.Printf("[REQUEST-OCR] end of processing request ID=%s | Phase: %s | Oracle: %d | Backend: %s | Model: %s | SeqNr: %d | Time: %s\n",
			requestID, phase, oracleID, backend, modelID, seqNr, elapsed.String())
	}
}

// recordMeasuredRequestPhase emits the same request-correlated end marker as a
// callback boundary when a duration is measured across components rather than
// by a single synchronous function. ROUND_ADMISSION is measured from the
// successful local queue import until the leader activates the request.
func recordMeasuredRequestPhase(r *metricRecorder, phase string, oracleID commontypes.OracleID, seqNr uint64, requestID string, duration time.Duration) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return
	}
	backend := "default"
	modelID := "default"
	if r != nil && strings.TrimSpace(r.backend) != "" {
		backend = strings.TrimSpace(r.backend)
		modelID = strings.TrimSpace(r.modelID)
	}
	fmt.Printf("[REQUEST-OCR] end of processing request ID=%s | Phase: %s | Oracle: %d | Backend: %s | Model: %s | SeqNr: %d | Time: %s\n",
		requestID, phase, oracleID, backend, modelID, seqNr, duration)
}

// Query is called by the round leader to build a query that will be broadcast
// to all other oracles for this seqNr.
//
// In many real OCR3 deployments, Query is empty and all oracles independently
// observe the world. Here we use Query to "assign work": the leader asks the
// active backend for the next request and puts it in the Query bytes.
func (p *cavsPlugin) Query(ctx context.Context, outctx ocr3types.OutcomeContext) (types.Query, error) {
	start := time.Now()
	defer func() {
		p.metrics.recordLeader("QUERY", outctx.SeqNr, start)
	}()

	request, ok, err := p.getCurrentRequest(ctx)
	if err != nil {
		fmt.Printf("QUERY oracle=%d error=%v\n", p.cfg.OracleID, err)
		return nil, err
	}
	if !ok || request.RequestID == "" || strings.TrimSpace(request.Statement) == "" {
		return nil, nil
	}
	defer requestProcessingBoundary(p.metrics, "QUERY", p.cfg.OracleID, outctx.SeqNr, request.RequestID)()
	if !request.queueImportedAt.IsZero() {
		admissionDuration := time.Since(request.queueImportedAt)
		p.metrics.recordDuration("ROUND_ADMISSION", outctx.SeqNr, 0, admissionDuration)
		recordMeasuredRequestPhase(p.metrics, phaseRoundAdmission, p.cfg.OracleID, outctx.SeqNr, request.RequestID, admissionDuration)
		if request.admissionDelay > 0 {
			p.metrics.recordDuration("INJECTED_SLEEP_"+phaseRoundAdmission, outctx.SeqNr, 0, request.admissionDelay)
			fmt.Printf("[PHASE-SLEEP] phase=%s configured=%s actual_gate=%s requestId=%s\n",
				phaseRoundAdmission, request.admissionDelay, admissionDuration, request.RequestID)
		}
	}
	if err := configuredPhaseSleeps.sleep(ctx, phaseQuery, p.metrics, outctx.SeqNr); err != nil {
		return nil, err
	}
	fmt.Printf("QUERY oracle=%d picked requestId=%s source=request-registry\n", p.cfg.OracleID, request.RequestID)
	b, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	return types.Query(b), nil
}

func observationIdempotencyKey(requestID string, oracleID commontypes.OracleID, seqNr uint64, body []byte) string {
	var identity bytes.Buffer
	identity.WriteString("cavs-observation-v1\n")
	identity.WriteString(strings.TrimSpace(requestID))
	identity.WriteByte('\n')
	identity.WriteString(strconv.FormatUint(uint64(oracleID), 10))
	identity.WriteByte('\n')
	identity.WriteString(strconv.FormatUint(seqNr, 10))
	identity.WriteByte('\n')
	identity.Write(body)
	sum := sha256.Sum256(identity.Bytes())
	return hex.EncodeToString(sum[:])
}

func newObservationHTTPClient(timeout time.Duration) *http.Client {
	// Node's default keep-alive timeout is shorter than Go's default 90-second
	// idle pool. That mismatch caused a pooled POST to hit a server-closed
	// socket mid-campaign. Give the extractor its own transport with a shorter,
	// explicit idle lifetime and no HTTP/2 upgrade (the endpoint is local
	// plain HTTP). Redirects are returned as ordinary non-2xx responses so one
	// explicit attempt cannot silently become multiple POSTs.
	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   30 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     false,
		Protocols:             protocols,
		MaxIdleConns:          100,
		IdleConnTimeout:       observationHTTPIdleConnTimeout,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: transport,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// retryableObservationTransportError classifies only failures returned before
// an HTTP response exists. Timeouts and context termination are intentionally
// excluded: retrying them would extend the OCR observation deadline and amplify
// provider latency. The caller protects ambiguous write failures with a stable
// Idempotency-Key.
func retryableObservationTransportError(ctx context.Context, err error) (string, bool) {
	if err == nil {
		return "", false
	}
	if ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return "context_terminated", false
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "transport_timeout", false
	}

	switch {
	case errors.Is(err, syscall.EPIPE):
		return "broken_pipe", true
	case errors.Is(err, syscall.ECONNRESET):
		return "connection_reset", true
	case errors.Is(err, syscall.ECONNABORTED):
		return "connection_aborted", true
	case errors.Is(err, io.ErrUnexpectedEOF):
		return "unexpected_eof", true
	case errors.Is(err, io.EOF):
		return "eof", true
	}

	// Some transports do not preserve the originating syscall error. Keep the
	// fallback deliberately narrow and limited to well-known connection-close
	// messages; arbitrary DNS, TLS, and provider errors are not retried.
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "server closed idle connection"):
		return "idle_connection_closed", true
	case strings.Contains(message, "connection reset by peer"):
		return "connection_reset", true
	case strings.Contains(message, "broken pipe"):
		return "broken_pipe", true
	case strings.Contains(message, "unexpected eof"):
		return "unexpected_eof", true
	}
	return "non_retryable_transport_error", false
}

// cancelOnCloseReadCloser keeps the request context alive until the caller has
// consumed and closed the response body. http.Client.Do returns after response
// headers are available, not after the body has been read; cancelling at Do's
// return can therefore truncate an otherwise successful JSON response.
type cancelOnCloseReadCloser struct {
	io.ReadCloser
	cancel context.CancelFunc
	once   sync.Once
}

func (body *cancelOnCloseReadCloser) Close() error {
	err := body.ReadCloser.Close()
	body.once.Do(body.cancel)
	return err
}

func (p *cavsPlugin) doObservationExtractionRequest(
	ctx context.Context,
	body []byte,
	requestID string,
	seqNr uint64,
) (response *http.Response, responseErr error) {
	if p.http == nil {
		return nil, errors.New("competence extraction HTTP client is nil")
	}
	var cancel context.CancelFunc
	if modelTimeout := observationModelCallTimeout(ctx, p.observationTimeout); modelTimeout > 0 {
		ctx, cancel = context.WithTimeout(ctx, modelTimeout)
		defer func() {
			if cancel == nil {
				return
			}
			if responseErr != nil || response == nil || response.Body == nil {
				cancel()
				return
			}
			response.Body = &cancelOnCloseReadCloser{
				ReadCloser: response.Body,
				cancel:     cancel,
			}
		}()
	}

	idempotencyKey := observationIdempotencyKey(requestID, p.cfg.OracleID, seqNr, body)
	requestIdentity := strings.TrimSpace(requestID)
	if requestIdentity == "" {
		requestIdentity = idempotencyKey
	}
	endpoint := p.skillExtractorURL + "/extract"

	for attempt := 1; attempt <= observationHTTPMaxAttempts; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			return nil, fmt.Errorf("create competence extraction request: %w", err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(observationIdempotencyHeader, idempotencyKey)
		req.Header.Set(observationRequestIdentityHeader, requestIdentity)

		// NewRequest gives a bytes.Reader-backed request a GetBody function.
		// Clear it so net/http cannot perform hidden replay attempts after the
		// Idempotency-Key marks this POST as replayable. This loop is the single
		// retry authority and therefore bounds transport attempts at two.
		req.GetBody = nil
		if attempt > 1 {
			// The retry must not reuse the connection that just failed.
			req.Close = true
		}

		resp, err := p.http.Do(req)
		if err == nil {
			if attempt > 1 {
				fmt.Printf("[OBSERVATION-HTTP-RETRY-SUCCESS] oracle=%d seqNr=%d requestId=%s attempts=%d\n",
					p.cfg.OracleID, seqNr, requestIdentity, attempt)
			}
			return resp, nil
		}
		if resp != nil {
			// A response means this was not a pre-response transport failure
			// (for example, a redirect-policy error), so it is never retried.
			if resp.Body != nil {
				_ = resp.Body.Close()
			}
			return nil, fmt.Errorf("competence extraction request failed after receiving a response: %w", err)
		}

		errorClass, retryable := retryableObservationTransportError(ctx, err)
		if !retryable || attempt == observationHTTPMaxAttempts {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return nil, ctxErr
			}
			if retryable {
				fmt.Printf("[OBSERVATION-HTTP-RETRY-EXHAUSTED] oracle=%d seqNr=%d requestId=%s attempts=%d errorClass=%s\n",
					p.cfg.OracleID, seqNr, requestIdentity, attempt, errorClass)
			}
			return nil, fmt.Errorf(
				"competence extraction request failed after %d attempt(s) (%s): %w",
				attempt,
				errorClass,
				err,
			)
		}

		fmt.Printf("[OBSERVATION-HTTP-RETRY] oracle=%d seqNr=%d requestId=%s failedAttempt=%d nextAttempt=%d maxAttempts=%d errorClass=%s freshConnection=true\n",
			p.cfg.OracleID,
			seqNr,
			requestIdentity,
			attempt,
			attempt+1,
			observationHTTPMaxAttempts,
			errorClass,
		)
		p.http.CloseIdleConnections()
	}

	return nil, errors.New("competence extraction request exhausted attempts")
}

// observationModelCallTimeout leaves enough time inside the OCR observation
// phase to encode and return a deterministic timeout vote. Using the full
// phase deadline for the HTTP call races libocr's callback cancellation and
// can prevent the fallback observation from reaching quorum.
func observationModelCallTimeout(ctx context.Context, phaseTimeout time.Duration) time.Duration {
	// Qualification evidence from 4,200 real-model observations fixed the
	// all-model p99 at 7.44s.  Eight seconds is therefore the predeclared common
	// provider SLA: calls beyond it become explicit zero-confidence,
	// "inconclusive analysis" observations instead of unbounded provider tails.
	// The same cap applies to every backend so model identity cannot change the
	// measurement's censoring rule.
	const modelCallHardCap = 8 * time.Second

	// The previous implementation computed the HTTP timeout from the original
	// phase budget even after queue import and request preparation had consumed
	// part of it.  That allowed an 18s call to start several seconds into a 20s
	// Observation and produced measured phases above the nominal cap.  Always
	// use the smaller of the configured budget and the parent context's actual
	// remaining deadline.
	budget := phaseTimeout
	if deadline, ok := ctx.Deadline(); ok {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return 0
		}
		if budget <= 0 || remaining < budget {
			budget = remaining
		}
	}
	if budget <= 0 {
		return modelCallHardCap
	}
	reserve := 5 * time.Second
	if proportionalReserve := budget / 10; proportionalReserve < reserve {
		reserve = proportionalReserve
	}
	if reserve <= 0 || reserve >= budget {
		if budget < modelCallHardCap {
			return budget
		}
		return modelCallHardCap
	}
	modelTimeout := budget - reserve
	if modelTimeout > modelCallHardCap {
		return modelCallHardCap
	}
	return modelTimeout
}

func observationTimeoutError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var timeoutErr net.Error
	return errors.As(err, &timeoutErr) && timeoutErr.Timeout()
}

func observationTimeoutReason(reason string) bool {
	reason = strings.ToLower(strings.TrimSpace(reason))
	return strings.Contains(reason, "timed out") ||
		strings.Contains(reason, "timeout") ||
		strings.Contains(reason, "deadline exceeded")
}

// observationTimeoutPayload reports whether any string in a structured error
// response identifies a timeout. Some provider gateways wrap the useful model
// error below a generic top-level error (for example, {"error":"request
// failed","detail":{"detail":"Request timed out"}}), so checking only the
// displayed top-level reason would incorrectly turn a valid inconclusive vote
// into an unavailable observation.
func observationTimeoutPayload(value any) bool {
	switch typed := value.(type) {
	case string:
		return observationTimeoutReason(typed)
	case map[string]any:
		for _, nested := range typed {
			if observationTimeoutPayload(nested) {
				return true
			}
		}
	case []any:
		for _, nested := range typed {
			if observationTimeoutPayload(nested) {
				return true
			}
		}
	}
	return false
}

func unavailableObservation(q queryPayload, reason string) (types.Observation, error) {
	available := false
	reason = strings.TrimSpace(reason)
	if reason == "" {
		reason = "observation backend unavailable"
	}
	b, err := json.Marshal(observationPayload{
		RequestID:     q.RequestID,
		OracleSetID:   q.OracleSetID,
		StatementHash: queryStatementHash(q),
		Available:     &available,
		Skills:        []simSkill{},
		AuthorSkills:  q.AuthorSkills,
		Competent:     false,
		Confidence:    0,
		Reason:        reason,
	})
	if err != nil {
		return nil, err
	}
	return types.Observation(b), nil
}

func timedOutObservation(q queryPayload, reason string) (types.Observation, error) {
	available := true
	reason = strings.TrimSpace(reason)
	if reason == "" {
		reason = "inconclusive analysis: model response exceeded configured deadline"
	}
	b, err := json.Marshal(observationPayload{
		RequestID:     q.RequestID,
		OracleSetID:   q.OracleSetID,
		StatementHash: queryStatementHash(q),
		Available:     &available,
		Skills:        []simSkill{},
		AuthorSkills:  q.AuthorSkills,
		Competent:     false,
		Confidence:    0,
		Reason:        reason,
	})
	if err != nil {
		return nil, err
	}
	return types.Observation(b), nil
}

func observationAvailable(op observationPayload) bool {
	return op.Available == nil || *op.Available
}

// Observation is called on every oracle after it receives the leader's Query.
//
// This is where each oracle contacts the external data source (the skill
// extractor service) and returns opaque bytes to libocr. libocr will:
// - sign the observation (offchain key)
// - send it to the leader
// - validate/aggregate it according to your other plugin methods
func (p *cavsPlugin) Observation(ctx context.Context, outctx ocr3types.OutcomeContext, query types.Query) (types.Observation, error) {
	start := time.Now()
	defer func() {
		p.metrics.record("OBSERVATION", outctx.SeqNr, 0, start)
	}()

	var q queryPayload
	if len(query) > 0 {
		if err := json.Unmarshal(query, &q); err != nil {
			return nil, fmt.Errorf("bad query json: %w", err)
		}
		// Each oracle receives the leader's Query but owns an independent
		// contract-request queue. Claim the selected request before doing any
		// observation work so a leader switch cannot select a follower's stale
		// pending copy. claimRequest also covers Query racing ahead of the
		// follower's local blob import.
		if p.localQueue != nil {
			p.localQueue.claimRequest(q.RequestID)
		}
	}
	defer requestProcessingBoundary(p.metrics, "OBSERVATION", p.cfg.OracleID, outctx.SeqNr, q.RequestID)()

	if len(query) == 0 || p.skillExtractorURL == "" {
		b, err := json.Marshal(observationPayload{
			RequestID:     q.RequestID,
			OracleSetID:   q.OracleSetID,
			StatementHash: queryStatementHash(q),
			Skills:        []simSkill{},
			AuthorSkills:  q.AuthorSkills,
		})
		if err != nil {
			return nil, err
		}
		return types.Observation(b), nil
	}

	if p.requestSource == requestSourceChain {
		waitTimeout := p.requestImportWait
		if waitTimeout <= 0 {
			waitTimeout = defaultRequestImportWaitTimeout
		}
		waitCtx, cancelWait := context.WithTimeout(ctx, waitTimeout)
		localRequest, ok, err := p.waitForStoredRequest(waitCtx, q.RequestID)
		cancelWait()
		if err != nil && ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if err != nil && !errors.Is(err, context.DeadlineExceeded) {
			return nil, fmt.Errorf("lookup local queued request %s: %w", q.RequestID, err)
		}
		if !ok {
			if p.postObservations {
				p.postObservationBestEffort(ctx, q.RequestID, outctx.SeqNr, nil, q.AuthorSkills, false, 0, "request not received")
			}
			if p.logObservations {
				fmt.Printf("OBS oracle=%d seqNr=%d requestId=%s competent=false conf=0.00 reason=request not received\n", p.cfg.OracleID, outctx.SeqNr, q.RequestID)
			}
			b, err := json.Marshal(observationPayload{
				RequestID:     q.RequestID,
				OracleSetID:   q.OracleSetID,
				StatementHash: queryStatementHash(q),
				Skills:        nil,
				AuthorSkills:  nil,
				Competent:     false,
				Confidence:    0,
				Reason:        "request not received",
			})
			if err != nil {
				return nil, err
			}
			return types.Observation(b), nil
		}
		q = localRequest
	}
	if err := configuredPhaseSleeps.sleep(ctx, phaseObservation, p.metrics, outctx.SeqNr); err != nil {
		return nil, err
	}

	if p.simulationMode {
		const (
			simulationConfidence = 0.75
			simulationReason     = "deterministic phase-isolation simulation"
		)
		if p.postObservations && q.RequestID != "" {
			p.postObservationBestEffort(ctx, q.RequestID, outctx.SeqNr, nil, q.AuthorSkills, true, simulationConfidence, simulationReason)
		}
		if p.logObservations {
			fmt.Printf("OBS_SIMULATION oracle=%d seqNr=%d requestId=%s competent=true conf=%.2f reason=%s\n",
				p.cfg.OracleID, outctx.SeqNr, q.RequestID, simulationConfidence, simulationReason)
		}
		b, err := json.Marshal(observationPayload{
			RequestID:     q.RequestID,
			OracleSetID:   q.OracleSetID,
			StatementHash: queryStatementHash(q),
			Skills:        nil,
			AuthorSkills:  q.AuthorSkills,
			Competent:     true,
			Confidence:    simulationConfidence,
			Reason:        simulationReason,
		})
		if err != nil {
			return nil, err
		}
		return types.Observation(b), nil
	}

	requestPayload := map[string]any{
		"text":      q.Statement,
		"holderDid": q.HolderDID,
		"requestId": q.RequestID,
	}
	if len(q.Presentation) > 0 {
		var presentation any
		if err := json.Unmarshal(q.Presentation, &presentation); err == nil {
			requestPayload["presentation"] = presentation
		} else {
			requestPayload["presentation"] = q.Presentation
		}
	} else if len(q.AuthorSkills) > 0 {
		requestPayload["authorSkills"] = q.AuthorSkills
	}
	if mode := strings.TrimSpace(p.competenceMode); mode != "" {
		requestPayload["competenceMode"] = mode
	}
	body, err := json.Marshal(requestPayload)
	if err != nil {
		return nil, fmt.Errorf("encode competence extraction request: %w", err)
	}
	resp, err := p.doObservationExtractionRequest(ctx, body, q.RequestID, outctx.SeqNr)
	if err != nil {
		if observationTimeoutError(err) {
			reason := fmt.Sprintf("inconclusive analysis: model response exceeded configured deadline: %v", err)
			if p.logObservations {
				fmt.Printf("OBS_TIMEOUT oracle=%d seqNr=%d requestId=%s competent=false conf=0.00 reason=%s\n", p.cfg.OracleID, outctx.SeqNr, q.RequestID, reason)
			}
			return timedOutObservation(q, reason)
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		reason := fmt.Sprintf("observation backend unavailable: %v", err)
		if p.logObservations {
			fmt.Printf("OBS_UNAVAILABLE oracle=%d seqNr=%d requestId=%s reason=%s\n", p.cfg.OracleID, outctx.SeqNr, q.RequestID, reason)
		}
		return unavailableObservation(q, reason)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		bodyBytes, _ := boundedReadAll(resp.Body, defaultMaxErrorBodyBytes)
		bodyText := strings.TrimSpace(string(bodyBytes))
		reason := fmt.Sprintf("CAVS /extract failed with HTTP %d", resp.StatusCode)
		if bodyText != "" {
			reason = fmt.Sprintf("%s: %s", reason, bodyText)
		}
		timedOut := observationTimeoutReason(reason)
		var errPayload map[string]any
		if err := json.Unmarshal(bodyBytes, &errPayload); err == nil {
			timedOut = timedOut || observationTimeoutPayload(errPayload)
			p.metrics.recordCAVSObservationTimings(outctx.SeqNr, errPayload)
			if raw, ok := errPayload["reason"].(string); ok && strings.TrimSpace(raw) != "" {
				reason = strings.TrimSpace(raw)
			} else if raw, ok := errPayload["error"].(string); ok && strings.TrimSpace(raw) != "" {
				reason = strings.TrimSpace(raw)
			}
		}
		if resp.StatusCode == http.StatusRequestTimeout || resp.StatusCode == http.StatusGatewayTimeout || timedOut || observationTimeoutReason(reason) {
			reason = fmt.Sprintf("inconclusive analysis: model response exceeded configured deadline (HTTP %d)", resp.StatusCode)
			if p.logObservations {
				fmt.Printf("OBS_TIMEOUT oracle=%d seqNr=%d requestId=%s competent=false conf=0.00 reason=%s\n", p.cfg.OracleID, outctx.SeqNr, q.RequestID, reason)
			}
			return timedOutObservation(q, reason)
		}
		if p.logObservations {
			fmt.Printf("OBS_UNAVAILABLE oracle=%d seqNr=%d requestId=%s reason=%s\n", p.cfg.OracleID, outctx.SeqNr, q.RequestID, reason)
		}
		return unavailableObservation(q, reason)
	}

	var responsePayload map[string]any
	if err := json.NewDecoder(io.LimitReader(resp.Body, defaultMaxHTTPBodyBytes)).Decode(&responsePayload); err != nil {
		if observationTimeoutError(err) {
			reason := fmt.Sprintf("inconclusive analysis: model response exceeded configured deadline: %v", err)
			if p.logObservations {
				fmt.Printf("OBS_TIMEOUT oracle=%d seqNr=%d requestId=%s competent=false conf=0.00 reason=%s\n", p.cfg.OracleID, outctx.SeqNr, q.RequestID, reason)
			}
			return timedOutObservation(q, reason)
		}
		reason := fmt.Sprintf("observation backend returned invalid JSON: %v", err)
		if p.logObservations {
			fmt.Printf("OBS_UNAVAILABLE oracle=%d seqNr=%d requestId=%s reason=%s\n", p.cfg.OracleID, outctx.SeqNr, q.RequestID, reason)
		}
		return unavailableObservation(q, reason)
	}
	p.metrics.recordCAVSObservationTimings(outctx.SeqNr, responsePayload)
	responseAuthorSkills := q.AuthorSkills
	if rawAuthorSkills, ok := responsePayload["authorSkills"].([]any); ok {
		responseAuthorSkills = normalizeAuthorSkillsInput(rawAuthorSkills)
	}

	comp, _ := responsePayload["competent"].(bool)
	conf, _ := responsePayload["confidence"].(float64)
	reason, _ := responsePayload["reason"].(string)
	if conf < 0 {
		conf = 0
	}
	if conf > 1 {
		conf = 1
	}
	if strings.TrimSpace(reason) == "" {
		reason = "no reason provided"
	}

	if p.postObservations && q.RequestID != "" {
		p.postObservationBestEffort(ctx, q.RequestID, outctx.SeqNr, nil, responseAuthorSkills, comp, conf, reason)
	}
	if p.logObservations {
		fmt.Printf("OBS oracle=%d seqNr=%d requestId=%s competent=%t conf=%.2f reason=%s\n", p.cfg.OracleID, outctx.SeqNr, q.RequestID, comp, conf, reason)
	}

	b, err := json.Marshal(observationPayload{
		RequestID:     q.RequestID,
		OracleSetID:   q.OracleSetID,
		StatementHash: queryStatementHash(q),
		Skills:        nil,
		AuthorSkills:  responseAuthorSkills,
		Competent:     comp,
		Confidence:    conf,
		Reason:        reason,
	})
	if err != nil {
		return nil, err
	}
	return types.Observation(b), nil
}

// ValidateObservation is called on every received observation to reject malformed
// data early.

// Returning nil here means "accept everything".
func (p *cavsPlugin) ValidateObservation(_ context.Context, _ ocr3types.OutcomeContext, query types.Query, ao types.AttributedObservation) error {
	var q queryPayload
	if len(query) != 0 {
		if err := json.Unmarshal(query, &q); err != nil {
			return fmt.Errorf("bad query json: %w", err)
		}
	}
	if strings.TrimSpace(q.RequestID) == "" {
		return nil
	}
	var op observationPayload
	if err := json.Unmarshal(ao.Observation, &op); err != nil {
		return fmt.Errorf("bad observation json: %w", err)
	}
	if strings.TrimSpace(op.RequestID) != strings.TrimSpace(q.RequestID) {
		return fmt.Errorf("observation requestID mismatch")
	}
	if strings.TrimSpace(q.OracleSetID) != "" && strings.TrimSpace(op.OracleSetID) != strings.TrimSpace(q.OracleSetID) {
		return fmt.Errorf("observation oracleSetID mismatch")
	}
	if expected := queryStatementHash(q); expected != "" && strings.TrimSpace(op.StatementHash) != expected {
		return fmt.Errorf("observation statementHash mismatch")
	}
	return nil
}

// postObservationBestEffort posts an oracle's observation to the queue for
// debugging/visibility. OCR3 does not require this; failures here should not
// impact the protocol, hence the best-effort behavior.
func (p *cavsPlugin) postObservationBestEffort(ctx context.Context, requestID string, seqNr uint64, skills []simSkill, authorSkills []string, comp bool, conf float64, reason string) {
	if (p.queueURL == "" && p.localQueue == nil) || requestID == "" {
		return
	}
	err := postObservation(ctx, p.http, p.queueURL, p.localQueue, requestID, storedObservation{
		OracleID:     int(p.cfg.OracleID),
		SeqNr:        seqNr,
		Skills:       skills,
		AuthorSkills: authorSkills,
		Competent:    comp,
		Confidence:   conf,
		Reason:       reason,
	})
	if err != nil {
		return
	}
}

// ObservationQuorum decides when the leader has enough valid observations to
// propose an outcome. The mode comes from the shared offchain config so every
// node uses the same rule.
//
//   - quorumModeTwoFPlusOne (DEFAULT): 2f+1. This is the BFT-standard quorum and
//     the value libocr recommends. The round proceeds as soon as an honest
//     majority has reported, so up to f crashed / partitioned / maliciously slow
//     oracles (e.g. the malicious "timeout" proxy) can no longer stall the DON.
//     To still reflect ALL backends in the common case, pair this with a
//     deltaGrace large enough that the remaining honest observations arrive
//     inside the grace window after 2f+1 is reached; only a genuinely
//     unavailable node is then left out, and only after the bounded grace.
//
//   - quorumModeAll: N (the original strict unanimity). Every outcome reflects
//     the full oracle set and the round waits for the slowest node, but this
//     trades away liveness fault tolerance — libocr only guarantees n-f
//     observations are ever collected, so a single unavailable node blocks every
//     round until it recovers. Use this only for honest-DON benchmarks where you
//     specifically need every model's response in the aggregate.
//
// Both rules are monotone in the observation set, as ObservationQuorum requires.
func (p *cavsPlugin) ObservationQuorum(_ context.Context, _ ocr3types.OutcomeContext, _ types.Query, attributedObservations []types.AttributedObservation) (bool, error) {
	available := 0
	for _, attributed := range attributedObservations {
		var observation observationPayload
		if err := json.Unmarshal(attributed.Observation, &observation); err != nil {
			continue
		}
		if observationAvailable(observation) {
			available++
		}
	}
	if p.pc.ObservationQuorumMode == quorumModeAll {
		return available >= p.cfg.N, nil
	}
	return available >= 2*p.cfg.F+1, nil
}

// Outcome deterministically aggregates the attributed observations into a single
// byte blob (ocr3types.Outcome).
//
// Determinism requirement (critical):
//   - Every honest oracle must compute identical Outcome bytes for a given input,
//     otherwise later report signatures will not verify and the round will fail.
func (p *cavsPlugin) Outcome(ctx context.Context, outctx ocr3types.OutcomeContext, query types.Query, attributedObservations []types.AttributedObservation) (ocr3types.Outcome, error) {
	start := time.Now()
	defer func() {
		p.metrics.record("OUTCOME", outctx.SeqNr, len(attributedObservations), start)
	}()

	var trust *trustPayload
	if p.pc.TrustEnabled {
		trust = decodePreviousTrust(outctx.PreviousOutcome, p.cfg.N, p.trustDIDs)
		trust.Trusted = computeTrusted(trust.Running, p.pc.TrustedBeliefMinBps, p.pc.TrustedUncertaintyMaxBps)
	}

	var q queryPayload
	if len(query) != 0 {
		if err := json.Unmarshal(query, &q); err != nil {
			return nil, fmt.Errorf("bad query json: %w", err)
		}
	}
	if q.RequestID == "" {
		// Carry trust forward only when the trust model is enabled.
		b, err := json.Marshal(outcomePayload{Trust: trust})
		if err != nil {
			return nil, err
		}
		return ocr3types.Outcome(b), nil
	}
	defer requestProcessingBoundary(p.metrics, "OUTCOME", p.cfg.OracleID, outctx.SeqNr, q.RequestID)()
	if err := configuredPhaseSleeps.sleep(ctx, phaseOutcome, p.metrics, outctx.SeqNr); err != nil {
		return nil, err
	}
	statementHash := queryStatementHash(q)

	sort.Slice(attributedObservations, func(i, j int) bool { return attributedObservations[i].Observer < attributedObservations[j].Observer })

	results := make([]obsResult, 0, len(attributedObservations))
	for _, ao := range attributedObservations {
		var op observationPayload
		if err := json.Unmarshal(ao.Observation, &op); err != nil {
			continue
		}
		if !observationAvailable(op) {
			continue
		}
		if strings.TrimSpace(op.RequestID) != strings.TrimSpace(q.RequestID) {
			continue
		}
		if strings.TrimSpace(q.OracleSetID) != "" && strings.TrimSpace(op.OracleSetID) != strings.TrimSpace(q.OracleSetID) {
			continue
		}
		if statementHash != "" && strings.TrimSpace(op.StatementHash) != statementHash {
			continue
		}
		c := op.Confidence
		if c < 0 {
			c = 0
		}
		if c > 1 {
			c = 1
		}
		w := uint32(0)
		if p.pc.TrustEnabled {
			idx := int(ao.Observer)
			if trust != nil && idx >= 0 && idx < len(trust.Running) {
				w = trustWeightBps(trust.Running[idx])
			}
		}
		results = append(results, obsResult{
			observer: ao.Observer,
			comp:     op.Competent,
			conf:     c,
			reason:   strings.TrimSpace(op.Reason),
			weight:   w,
		})
	}

	if len(results) == 0 {
		out := outcomePayload{
			RequestID:         q.RequestID,
			OracleSetID:       q.OracleSetID,
			RequesterEndpoint: q.RequesterEndpoint,
			Statement:         q.Statement,
			StatementHash:     statementHash,
			HolderDID:         q.HolderDID,
			Skills:            []simSkill{},
			Competent:         false,
			Confidence:        0,
			Reason:            "no valid observations",
			Trust:             trust,
		}
		b, err := json.Marshal(out)
		if err != nil {
			return nil, err
		}
		return ocr3types.Outcome(b), nil
	}

	totalWeight := uint32(0)
	trueWeight := uint32(0)
	trueCount := 0
	for _, r := range results {
		totalWeight += r.weight
		if r.comp {
			trueWeight += r.weight
			trueCount++
		}
	}
	aggComp := false
	if totalWeight == 0 {
		aggComp = trueCount*2 >= len(results)
	} else {
		aggComp = trueWeight*2 >= totalWeight
	}

	alignedResults := make([]obsResult, 0, len(results))
	for _, r := range results {
		if r.comp == aggComp {
			alignedResults = append(alignedResults, r)
		}
	}
	if len(alignedResults) == 0 {
		alignedResults = results
	}

	// Mean confidence over observations aligned with the aggregate competence.
	confVals := make([]weightedScore, 0, len(alignedResults))
	for _, r := range alignedResults {
		confVals = append(confVals, weightedScore{Score: r.conf, Weight: r.weight, Oracle: r.observer})
	}
	aggConf := weightedMean(confVals)

	if p.pc.TrustEnabled && trust != nil {
		// Update trust based on agreement with aggregate competence/confidence.
		reqEvidence := make([]trustEvidenceCounts, p.cfg.N)
		delta := p.pc.TrustDeltaBps
		aggScoreBps := decisionScoreBps(aggComp, aggConf)
		for _, r := range results {
			idx := int(r.observer)
			if idx < 0 || idx >= len(reqEvidence) {
				continue
			}
			compScore := decisionScoreBps(r.comp, r.conf)
			diff := absInt(compScore - aggScoreBps)
			if diff <= delta {
				reqEvidence[idx].Pos++
			} else if diff > 2*delta {
				reqEvidence[idx].Neg++
			} else {
				reqEvidence[idx].Unc++
			}
		}
		mergeTrustEvidence(trust.Pending, reqEvidence)
		trust.RequestsInEpoch++
		if trust.RequestsInEpoch >= trust.EpochLen {
			for i := 0; i < len(trust.Running) && i < len(trust.Pending); i++ {
				running := opinionFromBps(trust.Running[i])
				epochOpinion := evidenceToOpinion(trust.Pending[i])
				trust.Running[i] = opinionToBps(slConsensus(running, epochOpinion))
			}
			trust.Pending = initTrustEvidence(len(trust.Running))
			trust.RequestsInEpoch = 0
			trust.Epoch++
		}
		trust.Trusted = computeTrusted(trust.Running, p.pc.TrustedBeliefMinBps, p.pc.TrustedUncertaintyMaxBps)
	}

	// Select the reason nearest to the median text embedding, so the published
	// rationale follows the middle of the oracle explanations rather than an
	// arbitrary confidence-nearest string.
	bestReason, err := medianReason(alignedResults, p.reasonEmbedder)
	if err != nil {
		bestReason = fallbackReason(alignedResults, aggConf)
		if errors.Is(err, errReasonEmbeddingUnavailable) {
			reasonEmbeddingUnavailableLogOnce.Do(func() {
				fmt.Printf("reason embedding disabled err=%v\n", err)
			})
		} else {
			fmt.Printf("reason embedding degraded requestId=%s err=%v fallbackReason=%q\n", q.RequestID, err, bestReason)
		}
	}

	out := outcomePayload{
		RequestID:         q.RequestID,
		OracleSetID:       q.OracleSetID,
		RequesterEndpoint: q.RequesterEndpoint,
		Statement:         q.Statement,
		StatementHash:     statementHash,
		HolderDID:         q.HolderDID,
		Skills:            []simSkill{},
		Trust:             trust,
		Competent:         aggComp,
		Confidence:        aggConf,
		Reason:            bestReason,
	}
	b, err := json.Marshal(out)
	if err != nil {
		return nil, err
	}
	// An agreed Outcome is the boundary at which this request has finished
	// report generation. Retire it from the embedded queue immediately, before
	// report attestation/transmission, because libocr may start the next OCR
	// sequence while those later phases are still in flight. Waiting until
	// ShouldAcceptAttestedReport allowed the same active request to be selected
	// again and produce duplicate outcomes/reports in adjacent sequences.
	//
	// Failed observation rounds never call Outcome, so they still retain the
	// request for a replacement leader exactly as intended.
	if p.localQueue != nil {
		p.localQueue.completeRequest(q.RequestID)
	}
	return ocr3types.Outcome(b), nil
}

// Reports converts the agreed Outcome into one or more reports to be signed and
// (maybe) transmitted.
//
// Here the report bytes are exactly equal to the outcome bytes.
func (p *cavsPlugin) Reports(ctx context.Context, seqNr uint64, outcome ocr3types.Outcome) ([]ocr3types.ReportPlus[struct{}], error) {
	start := time.Now()
	defer func() {
		p.metrics.record("REPORTS", seqNr, 0, start)
	}()

	var out outcomePayload
	if len(outcome) == 0 {
		return nil, nil
	}
	if err := json.Unmarshal(outcome, &out); err != nil {
		return nil, err
	}
	if out.RequestID == "" {
		return nil, nil
	}
	defer requestProcessingBoundary(p.metrics, "REPORTS", p.cfg.OracleID, seqNr, out.RequestID)()
	if err := configuredPhaseSleeps.sleep(ctx, phaseReports, p.metrics, seqNr); err != nil {
		return nil, err
	}
	report := types.Report(outcome)
	return []ocr3types.ReportPlus[struct{}]{
		{
			ReportWithInfo: ocr3types.ReportWithInfo[struct{}]{Report: report, Info: struct{}{}},
		},
	}, nil
}

// ShouldAcceptAttestedReport is called after a report has collected enough
// onchain signatures to be considered "attested" (typically f+1 signers).
//
// Returning true means "this report is acceptable for potential transmission".
func (p *cavsPlugin) ShouldAcceptAttestedReport(ctx context.Context, seqNr uint64, report ocr3types.ReportWithInfo[struct{}]) (bool, error) {
	start := time.Now()
	defer func() {
		p.metrics.record("ACCEPT_CHECK", seqNr, 0, start)
	}()

	var out outcomePayload
	if err := json.Unmarshal(report.Report, &out); err == nil && strings.TrimSpace(out.RequestID) != "" {
		defer requestProcessingBoundary(p.metrics, "ACCEPT_CHECK", p.cfg.OracleID, seqNr, out.RequestID)()
		if err := configuredPhaseSleeps.sleep(ctx, phaseAcceptCheck, p.metrics, seqNr); err != nil {
			return false, err
		}
	}
	if p.queueURL != "" || p.localQueue != nil {
		if strings.TrimSpace(out.RequestID) != "" {
			if err := p.markRequestComplete(ctx, out.RequestID); err != nil {
				fmt.Printf("queue post completion error requestId=%s err=%v\n", out.RequestID, err)
			}
		}
	}
	return true, nil
}

// ShouldTransmitAcceptedReport is called right before transmission.
// Returning true means "actually transmit now (subject to the schedule)".
func (p *cavsPlugin) ShouldTransmitAcceptedReport(ctx context.Context, seqNr uint64, report ocr3types.ReportWithInfo[struct{}]) (bool, error) {
	start := time.Now()
	defer func() {
		p.metrics.record("TRANSMIT_CHECK", seqNr, 0, start)
	}()
	var out outcomePayload
	if err := json.Unmarshal(report.Report, &out); err == nil && strings.TrimSpace(out.RequestID) != "" {
		defer requestProcessingBoundary(p.metrics, "TRANSMIT_CHECK", p.cfg.OracleID, seqNr, out.RequestID)()
		if err := configuredPhaseSleeps.sleep(ctx, phaseTransmitCheck, p.metrics, seqNr); err != nil {
			return false, err
		}
	}
	return true, nil
}

// Close is called by libocr when the plugin instance is no longer needed.
func (p *cavsPlugin) Close() error { return nil }

// logTransmitter implements ocr3types.ContractTransmitter.
//
// In a real OCR3 deployment this would submit the report to an on-chain contract.
// Here we:
// - log a concise "TRANSMIT ..." line
// - submit the public outcome to the configured backend
type logTransmitter struct {
	oracleID      commontypes.OracleID
	from          types.Account
	queueURL      string
	localQueue    *requestQueue
	requestSource string
	http          *http.Client
	mu            sync.Mutex
	relayFailures map[string]int
	metrics       *metricRecorder
	// f is the OCR3 fault budget for the active oracle set; threshold = f+1.
	// Captured at construction so Transmit can stamp the relayed envelope
	// without re-reading the contract config.
	f                    uint8
	n                    int
	cavsEndpointTemplate string
}

type requesterRelayResponse struct {
	OK                         bool     `json:"ok"`
	Duplicate                  bool     `json:"duplicate,omitempty"`
	VCMinted                   bool     `json:"vcMinted,omitempty"`
	VCMintStatus               string   `json:"vcMintStatus,omitempty"`
	VCMintDurationMs           float64  `json:"vcMintDurationMs,omitempty"`
	OIssuerEndpoint            string   `json:"oissuerEndpoint,omitempty"`
	OIssuerOracleID            uint8    `json:"oissuerOracleId,omitempty"`
	SignerOracleIDs            []uint8  `json:"signerOracleIds,omitempty"`
	DroppedSignerOracleIDs     []uint8  `json:"droppedSignerOracleIds,omitempty"`
	UnavailableSignerOracleIDs []uint8  `json:"unavailableSignerOracleIds,omitempty"`
	SignerEndpoints            []string `json:"signerEndpoints,omitempty"`
	DroppedSignerEndpoints     []string `json:"droppedSignerEndpoints,omitempty"`
	UnavailableSignerEndpoints []string `json:"unavailableSignerEndpoints,omitempty"`
	CallbackSuccesses          int      `json:"callbackSuccesses,omitempty"`
	CallbackFailures           int      `json:"callbackFailures,omitempty"`
	CallbackFailedEndpoints    []struct {
		Endpoint string `json:"endpoint,omitempty"`
		Error    string `json:"error,omitempty"`
	} `json:"callbackFailedEndpoints,omitempty"`
	Threshold int `json:"threshold,omitempty"`
}

type vcIssueRequest struct {
	RequestID         string         `json:"requestId,omitempty"`
	RequesterEndpoint string         `json:"requesterEndpoint,omitempty"`
	StatementHash     string         `json:"statementHash,omitempty"`
	HolderDID         string         `json:"holderDid,omitempty"`
	Competent         bool           `json:"competent"`
	Confidence        float64        `json:"confidence"`
	Reason            string         `json:"reason,omitempty"`
	SignerEndpoints   []string       `json:"signerEndpoints"`
	AttestedThreshold uint8          `json:"attestedThreshold,omitempty"`
	CallbackEndpoints []string       `json:"callbackEndpoints,omitempty"`
	Result            outcomePayload `json:"result"`
	RemoteSigners     bool           `json:"remoteSigners"`
}

// FromAccount tells libocr which transmitter identity we are using.
func (t *logTransmitter) FromAccount(context.Context) (types.Account, error) { return t.from, nil }

// attestedSignerOracleIDs extracts the de-duplicated, sorted oracle IDs that
// contributed valid signatures to the attested report. Used to publish a
// signer pool on the off-chain relay envelope so downstream VC issuance can
// route around an unavailable signer without losing the attestation.
func attestedSignerOracleIDs(sigs []types.AttributedOnchainSignature) []uint8 {
	if len(sigs) == 0 {
		return nil
	}
	seen := make(map[uint8]struct{}, len(sigs))
	ids := make([]uint8, 0, len(sigs))
	for _, sig := range sigs {
		id := uint8(sig.Signer)
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

func chooseOIssuerOracleID(signers []uint8, requestID string, configDigest types.ConfigDigest, seqNr uint64) (uint8, bool) {
	if len(signers) == 0 {
		return 0, false
	}
	material := fmt.Sprintf("%s|%s|%d", strings.TrimSpace(requestID), configDigest.Hex(), seqNr)
	sum := sha256.Sum256([]byte(material))
	idx := binary.BigEndian.Uint64(sum[:8]) % uint64(len(signers))
	return signers[idx], true
}

func oracleCAVSEndpoint(template string, oracleID uint8) string {
	template = strings.TrimSpace(template)
	if template == "" {
		template = "http://cavs{oracleId}:4200"
	}
	id := strconv.Itoa(int(oracleID))
	out := strings.ReplaceAll(template, "{oracleId}", id)
	out = strings.ReplaceAll(out, "${oracleId}", id)
	out = strings.ReplaceAll(out, "{id}", id)
	return strings.TrimRight(out, "/")
}

func oracleCAVSEndpoints(template string, n int) []string {
	if n <= 0 {
		return nil
	}
	endpoints := make([]string, 0, n)
	for i := 0; i < n; i++ {
		endpoints = append(endpoints, oracleCAVSEndpoint(template, uint8(i)))
	}
	return endpoints
}

func oracleIDsForCAVSEndpoints(template string, n int, endpoints []string) []uint8 {
	if n <= 0 || len(endpoints) == 0 {
		return nil
	}
	byEndpoint := make(map[string]uint8, n)
	for i := 0; i < n; i++ {
		byEndpoint[oracleCAVSEndpoint(template, uint8(i))] = uint8(i)
	}
	ids := make([]uint8, 0, len(endpoints))
	seen := map[uint8]struct{}{}
	for _, endpoint := range endpoints {
		id, ok := byEndpoint[strings.TrimRight(strings.TrimSpace(endpoint), "/")]
		if !ok {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

// Transmit is called by libocr once the report is attested and this oracle is
// selected by the transmission schedule.
//
// `sigs` is the attributed signature set libocr gathered while assembling the
// attested report. Our fork of libocr no longer caps this slice at f+1, so the
// transmitter typically sees more than the bare-quorum signer set. We stamp
// the oracle IDs (plus the f+1 threshold) onto the off-chain relay envelope so
// the downstream VC-issuance flow has a redundant signer pool to draw from.
func (t *logTransmitter) Transmit(ctx context.Context, configDigest types.ConfigDigest, seqNr uint64, reportWithInfo ocr3types.ReportWithInfo[struct{}], sigs []types.AttributedOnchainSignature) error {
	startTotal := time.Now()
	defer func() {
		t.metrics.record("TRANSMIT_TOTAL", seqNr, 0, startTotal)
	}()

	var out outcomePayload
	if err := json.Unmarshal(reportWithInfo.Report, &out); err != nil {
		return err
	}
	defer requestProcessingBoundary(t.metrics, "TRANSMIT_TOTAL", t.oracleID, seqNr, out.RequestID)()
	if err := configuredPhaseSleeps.sleep(ctx, phaseTransmitTotal, t.metrics, seqNr); err != nil {
		return err
	}
	if strings.TrimSpace(out.StatementHash) == "" && strings.TrimSpace(out.Statement) != "" {
		out.StatementHash = statementHashHex(out.Statement)
	}
	publicOut := out
	publicOut.Trust = nil
	publicOut.AttestedSignerOracleIDs = attestedSignerOracleIDs(sigs)
	publicOut.AttestedThreshold = t.f + 1
	publicOut.AttestedSeqNr = seqNr
	publicOut.AttestedConfigDigest = configDigest.Hex()

	fmt.Printf("TRANSMIT oracle=%d from=%s configDigest=%s seqNr=%d requestId=%s sigs=%d signers=%v threshold=%d competent=%t conf=%.2f\n",
		t.oracleID, string(t.from), configDigest.Hex(), seqNr, out.RequestID, len(sigs), publicOut.AttestedSignerOracleIDs, publicOut.AttestedThreshold, out.Competent, out.Confidence)

	if out.RequestID != "" {
		if strings.TrimSpace(out.RequesterEndpoint) == "" {
			err := fmt.Errorf("%w for requestId=%s", errMissingRequesterEndpoint, out.RequestID)
			fmt.Printf("OIss relay dropped requestId=%s err=%v\n", out.RequestID, err)
			t.clearRelayFailure(out.RequestID)
			return nil
		}
		oIssuerID, ok := chooseOIssuerOracleID(publicOut.AttestedSignerOracleIDs, out.RequestID, configDigest, seqNr)
		if !ok {
			return fmt.Errorf("cannot choose OIss for requestId=%s: no attested signers", out.RequestID)
		}
		startRelay := time.Now()
		relayResp, err := t.relayResultToOIssuer(ctx, publicOut, oIssuerID)
		if err != nil {
			t.metrics.record("OISS_RELAY", seqNr, 0, startRelay)
			if errors.Is(err, errMissingRequesterEndpoint) {
				fmt.Printf("OIss relay dropped requestId=%s err=%v\n", out.RequestID, err)
				t.clearRelayFailure(out.RequestID)
				return nil
			}
			failures := t.recordRelayFailure(out.RequestID)
			if failures >= maxRequesterRelayFailures {
				fmt.Printf("OIss relay giving up requestId=%s attempts=%d err=%v\n", out.RequestID, failures, err)
				// This request is terminal from the transmitter's perspective;
				// retaining its counter forever leaks one map entry per failed
				// request in a long-lived oracle process.
				t.clearRelayFailure(out.RequestID)
			} else {
				return err
			}
		} else {
			t.metrics.record("OISS_RELAY", seqNr, 0, startRelay)
			t.clearRelayFailure(out.RequestID)
			t.logRequesterVCResponse(seqNr, out.RequestID, relayResp)
		}
	}
	return nil
}

func (t *logTransmitter) logRequesterVCResponse(seqNr uint64, requestID string, resp *requesterRelayResponse) {
	if resp == nil {
		return
	}
	status := strings.TrimSpace(resp.VCMintStatus)
	if status == "" {
		switch {
		case resp.VCMinted:
			status = "minted"
		case resp.Duplicate:
			status = "duplicate"
		default:
			status = "unknown"
		}
	}
	if resp.VCMintDurationMs > 0 {
		t.metrics.recordDuration("VC_MINT", seqNr, 0, time.Duration(resp.VCMintDurationMs*float64(time.Millisecond)))
	}
	fmt.Printf("TRANSMITTER_VC oracle=%d requestId=%s seqNr=%d status=%s minted=%t oissuer=%d oissuerEndpoint=%s threshold=%d signers=%v dropped=%v unavailable=%v callbacksOK=%d callbacksFailed=%d vcMs=%.1f duplicate=%t\n",
		t.oracleID, requestID, seqNr, status, resp.VCMinted, resp.OIssuerOracleID, resp.OIssuerEndpoint, resp.Threshold, resp.SignerOracleIDs, resp.DroppedSignerOracleIDs, resp.UnavailableSignerOracleIDs, resp.CallbackSuccesses, resp.CallbackFailures, resp.VCMintDurationMs, resp.Duplicate)
	if len(resp.DroppedSignerOracleIDs) > 0 || len(resp.UnavailableSignerOracleIDs) > 0 {
		fmt.Printf("TRANSMITTER_VC_SIGNER_DROP oracle=%d requestId=%s seqNr=%d used=%v dropped=%v unavailable=%v threshold=%d\n",
			t.oracleID, requestID, seqNr, resp.SignerOracleIDs, resp.DroppedSignerOracleIDs, resp.UnavailableSignerOracleIDs, resp.Threshold)
	}
}

func (t *logTransmitter) recordRelayFailure(requestID string) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.relayFailures == nil {
		t.relayFailures = map[string]int{}
	}
	t.relayFailures[requestID]++
	return t.relayFailures[requestID]
}

func (t *logTransmitter) clearRelayFailure(requestID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.relayFailures == nil {
		return
	}
	delete(t.relayFailures, requestID)
}

func (t *logTransmitter) relayResultToOIssuer(ctx context.Context, out outcomePayload, oIssuerID uint8) (*requesterRelayResponse, error) {
	requesterEndpoint := strings.TrimSpace(out.RequesterEndpoint)
	if requesterEndpoint == "" {
		return nil, fmt.Errorf("%w for requestId=%s", errMissingRequesterEndpoint, out.RequestID)
	}
	oIssuerEndpoint := oracleCAVSEndpoint(t.cavsEndpointTemplate, oIssuerID)
	signerEndpoints := make([]string, 0, len(out.AttestedSignerOracleIDs))
	for _, signerID := range out.AttestedSignerOracleIDs {
		signerEndpoints = append(signerEndpoints, oracleCAVSEndpoint(t.cavsEndpointTemplate, signerID))
	}
	body, err := json.Marshal(vcIssueRequest{
		RequestID:         out.RequestID,
		RequesterEndpoint: requesterEndpoint,
		StatementHash:     out.StatementHash,
		HolderDID:         out.HolderDID,
		Competent:         out.Competent,
		Confidence:        out.Confidence,
		Reason:            out.Reason,
		SignerEndpoints:   signerEndpoints,
		AttestedThreshold: out.AttestedThreshold,
		CallbackEndpoints: oracleCAVSEndpoints(t.cavsEndpointTemplate, t.n),
		Result:            out,
		RemoteSigners:     true,
	})
	if err != nil {
		return nil, err
	}
	client := t.http
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	url := oIssuerEndpoint + "/ocr/vc"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("relay to OIss endpoint %s: %w", url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	bodyBytes, err := boundedReadAll(resp.Body, defaultMaxHTTPBodyBytes)
	if err != nil {
		return nil, fmt.Errorf("relay to OIss endpoint %s returned invalid body: %w", url, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("relay to OIss endpoint %s failed with http %d: %s", url, resp.StatusCode, strings.TrimSpace(string(bodyBytes)))
	}
	var relayResp requesterRelayResponse
	if len(bytes.TrimSpace(bodyBytes)) > 0 {
		if err := json.Unmarshal(bodyBytes, &relayResp); err == nil {
			relayResp.OIssuerOracleID = oIssuerID
			relayResp.OIssuerEndpoint = oIssuerEndpoint
			if len(relayResp.SignerOracleIDs) == 0 {
				relayResp.SignerOracleIDs = oracleIDsForCAVSEndpoints(t.cavsEndpointTemplate, t.n, relayResp.SignerEndpoints)
			}
			if len(relayResp.DroppedSignerOracleIDs) == 0 {
				relayResp.DroppedSignerOracleIDs = oracleIDsForCAVSEndpoints(t.cavsEndpointTemplate, t.n, relayResp.DroppedSignerEndpoints)
			}
			if len(relayResp.UnavailableSignerOracleIDs) == 0 {
				relayResp.UnavailableSignerOracleIDs = oracleIDsForCAVSEndpoints(t.cavsEndpointTemplate, t.n, relayResp.UnavailableSignerEndpoints)
			}
			return &relayResp, nil
		}
	}
	return &requesterRelayResponse{OK: true, OIssuerOracleID: oIssuerID, OIssuerEndpoint: oIssuerEndpoint}, nil
}

// normalizeSkills:
// - keeps only the best score per URI
// - enforces ScoreBps ∈ [0,10000]
// - returns at most the fixed internal skill limit
// - sorts deterministically (first by score desc, then URI asc, then final URI asc)
//
// This function is used both in Observation() and Outcome() paths. Determinism
// matters: different ordering can lead to different report bytes and signature
// verification failures.
func normalizeSkills(in []simSkill) []simSkill {
	bestByURI := map[string]simSkill{}
	for _, s := range in {
		if s.URI == "" {
			continue
		}
		if s.ScoreBps > 10000 {
			continue
		}
		prev, ok := bestByURI[s.URI]
		if !ok || s.ScoreBps > prev.ScoreBps {
			bestByURI[s.URI] = s
		}
	}
	tmp := make([]simSkill, 0, len(bestByURI))
	for _, s := range bestByURI {
		tmp = append(tmp, s)
	}
	sort.Slice(tmp, func(i, j int) bool {
		if tmp[i].ScoreBps != tmp[j].ScoreBps {
			return tmp[i].ScoreBps > tmp[j].ScoreBps
		}
		return tmp[i].URI < tmp[j].URI
	})
	if len(tmp) > fixedSkillsTopK {
		tmp = tmp[:fixedSkillsTopK]
	}
	sort.Slice(tmp, func(i, j int) bool { return tmp[i].URI < tmp[j].URI })
	return tmp
}

func statementHashHex(statement string) string {
	sum := sha256.Sum256([]byte(statement))
	return fmt.Sprintf("%x", sum[:])
}

func queryStatementHash(q queryPayload) string {
	if strings.TrimSpace(q.StatementHash) != "" {
		return strings.TrimSpace(q.StatementHash)
	}
	if strings.TrimSpace(q.Statement) == "" {
		return ""
	}
	return statementHashHex(q.Statement)
}

// hashJitterBps provides a deterministic "tiny random" jitter used to break ties
// consistently across oracles without relying on actual randomness.
func hashJitterBps(requestID string, uri string) int {
	h := sha256.Sum256([]byte(requestID + "|" + uri))
	return int(binary.BigEndian.Uint16(h[:2]) % 1000) // 0..999
}

// skillsFromSkillExtractorResponse parses a skill extractor response into []simSkill.
//
// The backing CAVS/extractor service has changed output shapes over time; this parser
// accepts several common variants. We intentionally:
// - extract stable skill IDs/URIs
// - compute a deterministic ScoreBps based on frequency + a deterministic tie-breaker
// - normalize/sort so that the final Observation bytes are deterministic
func skillsFromSkillExtractorResponse(payload map[string]any, requestID string) ([]simSkill, error) {
	var skillsAny any
	if v, ok := payload["skills"]; ok {
		skillsAny = v
	} else if rs, ok := payload["results"].([]any); ok && len(rs) > 0 {
		if r0, ok := rs[0].(map[string]any); ok {
			if v, ok := r0["mapped_skills"]; ok {
				skillsAny = v
			} else if v, ok := r0["skills"]; ok {
				skillsAny = v
			}
		}
	}
	if skillsAny == nil {
		return []simSkill{}, nil
	}

	ids := map[string]int{}
	labels := map[string]string{}
	var walk func(v any)
	walk = func(v any) {
		switch vv := v.(type) {
		case []any:
			// Handle legacy shape: [skill_entity, [match_skill, match_id]]
			if len(vv) == 2 {
				if inner, ok := vv[1].([]any); ok && len(inner) == 2 {
					label, _ := inner[0].(string)
					id, _ := inner[1].(string)
					id = strings.TrimSpace(id)
					if id != "" {
						ids[id]++
						if label != "" && labels[id] == "" {
							labels[id] = label
						}
						return
					}
				}
				if inner, ok := vv[1].(map[string]any); ok {
					label, _ := inner["match_skill"].(string)
					id, _ := inner["match_id"].(string)
					id = strings.TrimSpace(id)
					if id != "" {
						ids[id]++
						if label != "" && labels[id] == "" {
							labels[id] = label
						}
						return
					}
				}
			}
			for _, x := range vv {
				walk(x)
			}
		case map[string]any:
			// Common keys (depending on extractor/version).
			idKeys := []string{"match_id", "id", "uri", "skill_id", "esco_id"}
			labelKeys := []string{"match_skill", "name", "skill", "label"}
			var id string
			for _, k := range idKeys {
				if s, ok := vv[k].(string); ok && strings.TrimSpace(s) != "" {
					id = strings.TrimSpace(s)
					break
				}
			}
			if id != "" {
				ids[id]++
				if labels[id] == "" {
					for _, k := range labelKeys {
						if s, ok := vv[k].(string); ok && strings.TrimSpace(s) != "" {
							labels[id] = strings.TrimSpace(s)
							break
						}
					}
				}
				return
			}
			for _, x := range vv {
				walk(x)
			}
		default:
		}
	}
	walk(skillsAny)

	out := make([]simSkill, 0, len(ids))
	for id, c := range ids {
		score := c*1000 + hashJitterBps(requestID, id)
		if score > 10000 {
			score = 10000
		}
		out = append(out, simSkill{URI: id, Label: labels[id], ScoreBps: uint16(score)})
	}
	return normalizeSkills(out), nil
}

// derivedNode bundles everything we need to describe an oracle identity set.
//
// Offchain/config identities come from the oracle's own seed. Onchain
// identities come from the per-oracle DID registry.
type derivedNode struct {
	offKR         *offchainKeyring
	onchainPub    types.OnchainPublicKey
	fromAcct      types.Account
	peerID        string
	registryEntry didRegistryEntry
}

// deriveNode deterministically derives one oracle identity bundle from the
// oracle's own seed plus its DID-backed onchain identity.
func deriveNode(oracleID int, oracleSeed int64, cavsURL string, entry didRegistryEntry, client *http.Client) (derivedNode, confighelper.OracleIdentityExtra, error) {
	if entry.OracleID != oracleID {
		return derivedNode{}, confighelper.OracleIdentityExtra{}, fmt.Errorf("registry entry has oracle_id=%d, want %d", entry.OracleID, oracleID)
	}
	offKR, err := newOffchainKeyringGeneration(oracleSeed, oracleID)
	if err != nil {
		return derivedNode{}, confighelper.OracleIdentityExtra{}, err
	}
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	addr, err := resolveDIDEthAddressViaCAVS(client, cavsURL, entry.DID)
	if err != nil {
		return derivedNode{}, confighelper.OracleIdentityExtra{}, err
	}
	onchainPub, from, err := onchainPublicKeyFromAddress(addr)
	if err != nil {
		return derivedNode{}, confighelper.OracleIdentityExtra{}, err
	}
	pid, err := ragetypes.PeerIDFromPrivateKey(offKR.offPriv)
	if err != nil {
		return derivedNode{}, confighelper.OracleIdentityExtra{}, err
	}
	node := derivedNode{
		offKR:         offKR,
		onchainPub:    onchainPub,
		fromAcct:      from,
		peerID:        pid.String(),
		registryEntry: entry,
	}
	oracle := confighelper.OracleIdentityExtra{
		OracleIdentity: confighelper.OracleIdentity{
			OffchainPublicKey: offKR.OffchainPublicKey(),
			OnchainPublicKey:  onchainPub,
			PeerID:            pid.String(),
			TransmitAccount:   from,
		},
		ConfigEncryptionPublicKey: offKR.ConfigEncryptionPublicKey(),
	}
	return node, oracle, nil
}

// deriveAllNodes deterministically derives all oracle public identities from
// the per-oracle seed list and combines them with the onchain addresses
// resolved by CAVS from the DID registry.
func deriveAllNodes(n int, oracleSeeds []int64, cavsURL string, registry []didRegistryEntry) ([]derivedNode, []confighelper.OracleIdentityExtra, error) {
	if len(registry) != n {
		return nil, nil, fmt.Errorf("registry length %d does not match n=%d", len(registry), n)
	}
	if len(oracleSeeds) != n {
		return nil, nil, fmt.Errorf("oracle seed count %d does not match n=%d", len(oracleSeeds), n)
	}
	nodes := make([]derivedNode, 0, n)
	oracles := make([]confighelper.OracleIdentityExtra, 0, n)
	client := &http.Client{Timeout: 30 * time.Second}
	for i := 0; i < n; i++ {
		node, oracle, err := deriveNode(i, oracleSeeds[i], cavsURL, registry[i], client)
		if err != nil {
			return nil, nil, err
		}
		nodes = append(nodes, node)
		oracles = append(oracles, oracle)
	}
	return nodes, oracles, nil
}

func newConfigDigester() evmutil.EVMOffchainConfigDigester {
	contractAddr := common.HexToAddress("0x" + strings.Repeat("11", 20))
	return evmutil.EVMOffchainConfigDigester{ChainID: 1337, ContractAddress: contractAddr}
}

// buildContractConfig generates a deterministic OCR3 contract config (including
// onchain/offchain config blobs) for this service.
//
// In real OCR3, this config would be set on-chain via `setConfig(...)` and the
// oracles would learn it through ContractConfigTracker + their DB.
func buildContractConfig(
	n int,
	f int,
	configSeed int64,
	oracleSeeds []int64,
	cavsURL string,
	registry []didRegistryEntry,
	timing ocrTimingConfig,
	trustEnabled bool,
	trustDeltaBps int,
	trustedBeliefMinBps int,
	trustedUncertaintyMaxBps int,
	observationQuorumMode string,
) (types.ContractConfig, evmutil.EVMOffchainConfigDigester, error) {
	if err := timing.validate(); err != nil {
		return types.ContractConfig{}, evmutil.EVMOffchainConfigDigester{}, err
	}
	_, oracles, err := deriveAllNodes(n, oracleSeeds, cavsURL, registry)
	if err != nil {
		return types.ContractConfig{}, evmutil.EVMOffchainConfigDigester{}, err
	}
	pluginCfgBytes, _ := json.Marshal(pluginConfig{
		TrustEnabled:             trustEnabled,
		TrustDeltaBps:            trustDeltaBps,
		TrustedBeliefMinBps:      trustedBeliefMinBps,
		TrustedUncertaintyMaxBps: trustedUncertaintyMaxBps,
		ObservationQuorumMode:    normalizeQuorumMode(observationQuorumMode),
	})

	ephemeralSk := sha256.Sum256([]byte(fmt.Sprintf("ephemeralSk|%d", configSeed)))
	var sharedSecret [16]byte
	sharedSecretHash := sha256.Sum256([]byte(fmt.Sprintf("sharedSecret|%d", configSeed)))
	copy(sharedSecret[:], sharedSecretHash[:16])

	// STRICT UNANIMITY invariant (see ObservationQuorum): the leader proposes
	// only after ALL N observations arrive, so a round's wall time is the SLOWEST
	// node's observation. Two constraints follow:
	//   1. deltaProgress MUST exceed maxDurObs (+ message round-trips), otherwise
	//      the pacemaker rotates the leader before the slowest node answers and
	//      the round livelocks instead of completing.
	//   2. maxDurObs MUST exceed the worst-case healthy /extract call, bounded by
	//      the selected checker's service timeout (the publication Azure limit is
	//      200s): the checker returns an HTTP 503 at that point, which the oracle
	//      records as a competent=false
	//      observation that still counts toward the N quorum. If a node cannot
	//      answer within maxDurObs the round (by design) halts.
	// deltaGrace is near-zero on purpose (set via the --delta_grace flag): with an
	// all-N quorum there are no stragglers left to collect once quorum is reached.
	// deltaRound is the FLOOR between OCR round starts, not a completion timeout.
	// OCR3 can run it aggressively, but it must still leave room for message
	// round-trips and local scheduling under the latency profile being tested.
	fmt.Printf("ocr timing deltaProgress=%s deltaResend=%s deltaInitial=%s deltaRound=%s deltaGrace=%s deltaCertifiedCommitRequest=%s deltaStage=%s rMax=%d maxDurQuery=%s maxDurObs=%s maxDurAccept=%s maxDurTransmit=%s\n",
		timing.DeltaProgress,
		timing.DeltaResend,
		timing.DeltaInitial,
		timing.DeltaRound,
		timing.DeltaGrace,
		timing.DeltaCertifiedCommitRequest,
		timing.DeltaStage,
		timing.RMax,
		timing.MaxDurationQuery,
		timing.MaxDurationObservation,
		timing.MaxDurationShouldAcceptAttestedReport,
		timing.MaxDurationShouldTransmitAcceptedReport,
	)

	// ContractSetConfigArgsDeterministic is a helper that produces:
	// - signer/transmitter lists
	// - onchainConfig bytes
	// - offchainConfig bytes
	// for the given oracle set and timing parameters.
	signers, transmitters, fOut, onchainCfg, offchainCfgVersion, offchainCfg, err := ocr3confighelper.ContractSetConfigArgsDeterministic(
		ephemeralSk,
		sharedSecret,
		timing.DeltaProgress,
		timing.DeltaResend,
		timing.DeltaInitial,
		timing.DeltaRound,
		timing.DeltaGrace,
		timing.DeltaCertifiedCommitRequest,
		timing.DeltaStage,
		timing.RMax,
		[]int{n},
		oracles,
		pluginCfgBytes,
		nil,
		timing.MaxDurationQuery,
		timing.MaxDurationObservation,
		timing.MaxDurationShouldAcceptAttestedReport,
		timing.MaxDurationShouldTransmitAcceptedReport,
		f,
		nil,
	)
	if err != nil {
		return types.ContractConfig{}, evmutil.EVMOffchainConfigDigester{}, err
	}

	// The digester determines how configDigest is computed. We use an EVM digester
	// with a dummy (but fixed) chainID + contract address so that all nodes agree.
	// We do this dummy part as our protocol works off chain.
	digester := newConfigDigester()

	cc := types.ContractConfig{
		ConfigCount:           1,
		Signers:               signers,
		Transmitters:          transmitters,
		F:                     fOut,
		OnchainConfig:         onchainCfg,
		OffchainConfigVersion: offchainCfgVersion,
		OffchainConfig:        offchainCfg,
	}
	cc.ConfigDigest, err = digester.ConfigDigest(context.Background(), cc)
	if err != nil {
		return types.ContractConfig{}, evmutil.EVMOffchainConfigDigester{}, err
	}
	return cc, digester, nil
}

// deriveBootstrapPriv deterministically derives the bootstrapper's Ed25519 key.
// This makes the bootstrap peerID stable across runs
func deriveBootstrapPriv(seed int64) ed25519.PrivateKey {
	h := sha256.Sum256([]byte(fmt.Sprintf("bootstrap|%d", seed)))
	return ed25519.NewKeyFromSeed(h[:])
}

// resolveHostnamePortToIP resolves "host:port" to "<ip>:port" if host is a DNS name.
//
// This is mostly here to make OCR's announced addresses more reliable in container
// networks, where "oracle0:20010" and the actual reachable IP can differ depending
// on the dialing side.
func resolveHostnamePortToIP(addr string) (string, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "", err
	}
	if net.ParseIP(host) != nil {
		return addr, nil
	}
	ips, err := net.LookupIP(host)
	if err != nil {
		return "", err
	}
	if len(ips) == 0 {
		return "", fmt.Errorf("no A/AAAA records for host %q", host)
	}
	var chosen net.IP
	for _, ip := range ips {
		if v4 := ip.To4(); v4 != nil {
			chosen = v4
			break
		}
	}
	if chosen == nil {
		chosen = ips[0]
	}
	return net.JoinHostPort(chosen.String(), port), nil
}

func httpPostJSONContext(ctx context.Context, client *http.Client, url string, body any, out any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		bodyBytes, _ := boundedReadAll(resp.Body, defaultMaxErrorBodyBytes)
		return fmt.Errorf("http %d: %s", resp.StatusCode, string(bodyBytes))
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(io.LimitReader(resp.Body, defaultMaxHTTPBodyBytes)).Decode(out)
}

func httpPostJSON(client *http.Client, url string, body any, out any) error {
	return httpPostJSONContext(context.Background(), client, url, body, out)
}

type cavsSetupResponse struct {
	OK       bool   `json:"ok"`
	OracleID int    `json:"oracleId"`
	DID      string `json:"did"`
}

func didRegistryFile(dir string, oracleID int) string {
	return filepath.Join(dir, fmt.Sprintf("oracle-%d.json", oracleID))
}

func contractConfigFile(dir string) string {
	return filepath.Join(dir, "ocr-contract-config.json")
}

func oracleLocalContractConfigFile(oracleID int) string {
	return filepath.Join(os.TempDir(), "cavsonocr", fmt.Sprintf("oracle-%d", oracleID), "ocr-contract-config.json")
}

func validateLoadedContractConfig(cc types.ContractConfig) (evmutil.EVMOffchainConfigDigester, error) {
	digester := newConfigDigester()
	if cc.ConfigCount == 0 {
		return evmutil.EVMOffchainConfigDigester{}, fmt.Errorf("contract config missing ConfigCount")
	}
	digest, err := digester.ConfigDigest(context.Background(), cc)
	if err != nil {
		return evmutil.EVMOffchainConfigDigester{}, err
	}
	if digest != cc.ConfigDigest {
		return evmutil.EVMOffchainConfigDigester{}, fmt.Errorf("contract config digest mismatch: file=%s computed=%s", cc.ConfigDigest.Hex(), digest.Hex())
	}
	return digester, nil
}

func writeContractConfigPath(path string, cc types.ContractConfig) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if _, err := validateLoadedContractConfig(cc); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cc, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func writeContractConfig(dir string, cc types.ContractConfig) error {
	return writeContractConfigPath(contractConfigFile(dir), cc)
}

func tryReadContractConfig(dir string) (types.ContractConfig, bool, evmutil.EVMOffchainConfigDigester, error) {
	path := contractConfigFile(dir)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return types.ContractConfig{}, false, evmutil.EVMOffchainConfigDigester{}, nil
		}
		return types.ContractConfig{}, false, evmutil.EVMOffchainConfigDigester{}, err
	}
	var cc types.ContractConfig
	if err := json.Unmarshal(data, &cc); err != nil {
		return types.ContractConfig{}, false, evmutil.EVMOffchainConfigDigester{}, fmt.Errorf("decode %s: %w", path, err)
	}
	digester, err := validateLoadedContractConfig(cc)
	if err != nil {
		return types.ContractConfig{}, false, evmutil.EVMOffchainConfigDigester{}, fmt.Errorf("validate %s: %w", path, err)
	}
	return cc, true, digester, nil
}

func waitForContractConfig(ctx context.Context, dir string, timeout time.Duration) (types.ContractConfig, evmutil.EVMOffchainConfigDigester, error) {
	waitCtx := ctx
	if timeout > 0 {
		var cancel context.CancelFunc
		waitCtx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		cc, ok, digester, err := tryReadContractConfig(dir)
		if err == nil && ok {
			return cc, digester, nil
		}
		select {
		case <-waitCtx.Done():
			if err != nil {
				return types.ContractConfig{}, evmutil.EVMOffchainConfigDigester{}, err
			}
			return types.ContractConfig{}, evmutil.EVMOffchainConfigDigester{}, fmt.Errorf("timed out waiting for contract config in %s", dir)
		case <-ticker.C:
		}
	}
}

const (
	cavsSetupRetryInitial = 100 * time.Millisecond
	cavsSetupRetryMax     = time.Second
)

func setupOracleIdentityViaCAVS(ctx context.Context, cavsURL string, oracleID int, timeout time.Duration) (didRegistryEntry, error) {
	if timeout <= 0 {
		timeout = 5 * time.Minute
	}
	setupCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	requestTimeout := timeout
	if requestTimeout < 2*time.Minute {
		requestTimeout = 2 * time.Minute
	}
	if requestTimeout > 10*time.Minute {
		requestTimeout = 10 * time.Minute
	}
	client := &http.Client{Timeout: requestTimeout}
	retryDelay := cavsSetupRetryInitial
	var lastErr error
	for {
		var resp cavsSetupResponse
		err := httpPostJSONContext(setupCtx, client, strings.TrimRight(cavsURL, "/")+"/setup", map[string]any{
			"oracleId": oracleID,
		}, &resp)
		if err == nil {
			if !resp.OK {
				err = fmt.Errorf("cavs setup oracle %d returned ok=false", oracleID)
			} else if strings.TrimSpace(resp.DID) == "" {
				err = fmt.Errorf("cavs setup oracle %d returned empty did", oracleID)
			} else if _, resolveErr := resolveDIDEthAddressViaCAVSContext(setupCtx, client, cavsURL, resp.DID); resolveErr != nil {
				err = fmt.Errorf("cavs setup oracle %d returned did that cavs cannot resolve: %w", oracleID, resolveErr)
			} else {
				return didRegistryEntry{
					OracleID: oracleID,
					DID:      strings.TrimSpace(resp.DID),
				}, nil
			}
		}
		lastErr = err
		timer := time.NewTimer(retryDelay)
		select {
		case <-setupCtx.Done():
			timer.Stop()
			if lastErr == nil {
				lastErr = setupCtx.Err()
			}
			return didRegistryEntry{}, fmt.Errorf("cavs setup oracle %d: %v: %w", oracleID, lastErr, setupCtx.Err())
		case <-timer.C:
		}
		if retryDelay < cavsSetupRetryMax {
			retryDelay *= 2
			if retryDelay > cavsSetupRetryMax {
				retryDelay = cavsSetupRetryMax
			}
		}
	}
}

const maxOracleStartupStagger = 20 * time.Second

// oracleStartupDelay is opt-in. The old unconditional oracleID*2s stagger made
// a healthy n=10 simulation spend 18 seconds doing no work before identity
// setup. Operators of rate-limited public RPCs can still request that behavior
// explicitly with OCR_ORACLE_STARTUP_STAGGER_STEP (for example "2s").
func oracleStartupDelay(oracleID int) (time.Duration, error) {
	if oracleID <= 0 {
		return 0, nil
	}
	raw, ok := envString("OCR_ORACLE_STARTUP_STAGGER_STEP")
	if !ok {
		return 0, nil
	}
	step, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("parse OCR_ORACLE_STARTUP_STAGGER_STEP=%q: %w", raw, err)
	}
	if step < 0 {
		return 0, fmt.Errorf("OCR_ORACLE_STARTUP_STAGGER_STEP must be >= 0, got %s", step)
	}
	if step > maxOracleStartupStagger/time.Duration(oracleID) {
		return maxOracleStartupStagger, nil
	}
	delay := time.Duration(oracleID) * step
	if delay > maxOracleStartupStagger {
		delay = maxOracleStartupStagger
	}
	return delay, nil
}

func writeDIDRegistryEntry(dir string, entry didRegistryEntry) error {
	if entry.OracleID < 0 {
		return fmt.Errorf("invalid oracle id %d", entry.OracleID)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	entry.DID = strings.TrimSpace(entry.DID)
	if entry.DID == "" {
		return fmt.Errorf("empty did")
	}

	data, err := json.MarshalIndent(entry, "", "  ")
	if err != nil {
		return err
	}
	path := didRegistryFile(dir, entry.OracleID)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func tryReadDIDRegistryEntry(dir string, oracleID int) (didRegistryEntry, bool, error) {
	path := didRegistryFile(dir, oracleID)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return didRegistryEntry{}, false, nil
		}
		return didRegistryEntry{}, false, err
	}
	var entry didRegistryEntry
	if err := json.Unmarshal(data, &entry); err != nil {
		return didRegistryEntry{}, false, fmt.Errorf("decode %s: %w", path, err)
	}
	if entry.OracleID != oracleID {
		return didRegistryEntry{}, false, fmt.Errorf("%s has oracle_id=%d, want %d", path, entry.OracleID, oracleID)
	}
	if strings.TrimSpace(entry.DID) == "" {
		return didRegistryEntry{}, false, fmt.Errorf("%s has empty did", path)
	}
	entry.DID = strings.TrimSpace(entry.DID)
	return entry, true, nil
}

func waitForDIDRegistryEntries(ctx context.Context, cavsURL string, dir string, n int, timeout time.Duration) ([]didRegistryEntry, error) {
	if n <= 0 {
		return nil, fmt.Errorf("invalid oracle count %d", n)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}

	waitCtx := ctx
	if timeout > 0 {
		var cancel context.CancelFunc
		waitCtx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}

	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	client := &http.Client{Timeout: 30 * time.Second}
	// Registry files arrive incrementally. Cache by DID so each polling pass
	// does not re-resolve every already-present identity over HTTP while waiting
	// for the final oracle file.
	resolvedAddresses := make(map[string]string, n)

	for {
		entries := make([]didRegistryEntry, n)
		addressOwners := make(map[string]int, n)
		ready := 0
		var readErr error

		for i := 0; i < n; i++ {
			entry, ok, err := tryReadDIDRegistryEntry(dir, i)
			if err != nil {
				readErr = err
				break
			}
			if !ok {
				continue
			}
			addr, resolved := resolvedAddresses[entry.DID]
			if !resolved {
				addr, err = resolveDIDEthAddressViaCAVSContext(waitCtx, client, cavsURL, entry.DID)
				if err != nil {
					readErr = fmt.Errorf("oracle %d resolve eth address via cavs: %w", i, err)
					break
				}
				resolvedAddresses[entry.DID] = addr
			}
			key := strings.ToLower(addr)
			if prev, exists := addressOwners[key]; exists {
				readErr = fmt.Errorf("duplicate CAVS-resolved eth_address %s for oracle %d and oracle %d", addr, prev, i)
				break
			}
			addressOwners[key] = i
			entries[i] = entry
			ready++
		}

		if readErr == nil && ready == n {
			return entries, nil
		}

		select {
		case <-waitCtx.Done():
			if readErr != nil {
				return nil, readErr
			}
			return nil, fmt.Errorf("timed out waiting for DID registry entries in %s (%d/%d present)", dir, ready, n)
		case <-ticker.C:
		}
	}
}

// runBootstrap starts the ragep2p bootstrapper (mode=bootstrap).
//
// The bootstrapper's job is to help oracles find and connect to each other.
// It doesn't participate in OCR rounds; it just aids p2p discovery.
func runBootstrap(
	ctx context.Context,
	n int,
	f int,
	seed int64,
	oracleSeeds []int64,
	listenAddr string,
	announceAddr string,
	cavsURL string,
	contractRPCURL string,
	contractAddress string,
	didRegistryDir string,
	didRegistryWaitTimeout time.Duration,
	timing ocrTimingConfig,
	trustEnabled bool,
	trustDeltaBps int,
	trustedBeliefMinBps int,
	trustedUncertaintyMaxBps int,
	observationQuorumMode string,
) error {
	if strings.TrimSpace(cavsURL) == "" {
		return fmt.Errorf("skill_extractor_url is required in mode=bootstrap to resolve DID addresses via CAVS")
	}
	if err := os.MkdirAll(didRegistryDir, 0o755); err != nil {
		return err
	}
	if err := os.Remove(contractConfigFile(didRegistryDir)); err != nil && !os.IsNotExist(err) {
		return err
	}
	registry, err := waitForDIDRegistryEntries(ctx, cavsURL, didRegistryDir, n, didRegistryWaitTimeout)
	if err != nil {
		return err
	}

	deployment, deployed, err := ensureBootstrapContractDeployment(ctx, bootstrapContractDeploymentRequest{
		RegistryDir:     didRegistryDir,
		OracleCount:     n,
		ContractRPCURL:  contractRPCURL,
		ContractAddress: contractAddress,
		CAVSURL:         cavsURL,
		Deployer:        registry[0],
	})
	if err != nil {
		return fmt.Errorf("ensure bootstrap contract deployment: %w", err)
	}

	cc, _, err := buildContractConfig(n, f, seed, oracleSeeds, cavsURL, registry, timing, trustEnabled, trustDeltaBps, trustedBeliefMinBps, trustedUncertaintyMaxBps, observationQuorumMode)
	if err != nil {
		return err
	}
	if err := writeContractConfig(didRegistryDir, cc); err != nil {
		return err
	}

	_, oracles, err := deriveAllNodes(n, oracleSeeds, cavsURL, registry)
	if err != nil {
		return err
	}
	peerIDs := make([]string, 0, n)
	for _, o := range oracles {
		peerIDs = append(peerIDs, o.PeerID)
	}

	announceAddrResolved, err := resolveHostnamePortToIP(announceAddr)
	if err != nil {
		return fmt.Errorf("resolve bootstrap_announce %q: %w", announceAddr, err)
	}

	priv := deriveBootstrapPriv(seed)
	pid, err := ragetypes.PeerIDFromPrivateKey(priv)
	if err != nil {
		return err
	}

	peer, err := networking.NewPeer(networking.PeerConfig{
		PrivKey:             priv,
		Logger:              quietLogger{log.New(os.Stdout, "", log.LstdFlags|log.Lmicroseconds)},
		V2ListenAddresses:   []string{listenAddr},
		V2AnnounceAddresses: []string{announceAddrResolved},
		V2DeltaReconcile:    250 * time.Millisecond,
		V2DeltaDial:         250 * time.Millisecond,
		V2EndpointConfig: networking.EndpointConfigV2{
			IncomingMessageBufferSize: 100,
			OutgoingMessageBufferSize: 50,
		},
		MetricsRegisterer: prometheus.NewRegistry(),
	})
	if err != nil {
		return err
	}
	defer func() { _ = peer.Close() }()

	bootstrapper, err := peer.OCR2BootstrapperFactory().NewBootstrapper(cc.ConfigDigest, peerIDs, nil, f)
	if err != nil {
		return err
	}
	if err := bootstrapper.Start(); err != nil {
		return err
	}
	defer func() { _ = bootstrapper.Close() }()

	if deployment.ContractAddress != "" {
		action := "using"
		if deployed {
			action = "deployed"
		}
		fmt.Printf("bootstrap contract %s coordinator=%s requestRegistry=%s tx=%s deployer=%s source=%s\n", action, deployment.ContractAddress, deployment.RequestRegistryAddress, deployment.TransactionHash, deployment.Deployer, deployment.Source)
	}
	fmt.Printf("bootstrap peerId=%s listen=%s announce=%s registry=%s configDigest=%s\n", pid.String(), listenAddr, announceAddrResolved, didRegistryDir, cc.ConfigDigest.Hex())
	<-ctx.Done()
	return nil
}

func registerOracleWithRetry(ctx context.Context, chainClient *noncentralizedclient.Client, oracleID int, timeout time.Duration) (*noncentralizedclient.RegisterResult, error) {
	return registerOracleWithRetryFunc(ctx, oracleID, timeout, chainClient.RegisterOracle)
}

func registerOracleWithRetryFunc(ctx context.Context, oracleID int, timeout time.Duration, register func(context.Context) (*noncentralizedclient.RegisterResult, error)) (*noncentralizedclient.RegisterResult, error) {
	if timeout <= 0 {
		timeout = 5 * time.Minute
	}
	retryCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	backoff := 5 * time.Second
	var lastErr error
	for attempt := 1; ; attempt++ {
		result, err := register(retryCtx)
		if err == nil {
			if attempt > 1 {
				fmt.Printf("oracle=%d registerOracle succeeded after attempt=%d\n", oracleID, attempt)
			}
			return result, nil
		}
		lastErr = err
		if retryCtx.Err() != nil {
			return nil, fmt.Errorf("oracle=%d registerOracle: %v: %w", oracleID, lastErr, retryCtx.Err())
		}
		fmt.Printf("oracle=%d registerOracle attempt=%d failed: %v; retrying in %s\n", oracleID, attempt, err, backoff)
		timer := time.NewTimer(backoff)
		select {
		case <-retryCtx.Done():
			timer.Stop()
			return nil, fmt.Errorf("oracle=%d registerOracle: %v: %w", oracleID, lastErr, retryCtx.Err())
		case <-timer.C:
		}
		if backoff < 30*time.Second {
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
	}
}

// runOracle starts a single OCR3 oracle node (mode=oracle).
//
// You typically run N of these (oracle_id=0..n-1). Each oracle:
// - joins the p2p network via the bootstrapper
// - runs the OCR3 state machine (libocr)
// - executes the cavsPlugin hooks when libocr asks for Query/Observation/Outcome/Reports
func runOracle(
	ctx context.Context,
	oracleID int,
	n int,
	f int,
	seed int64,
	oracleSeed int64,
	queueURL string,
	contractRPCURL string,
	contractBeaconURL string,
	contractAddress string,
	oraclePublicEndpoint string,
	bootstrapAddr string,
	p2pListen string,
	p2pAnnounce string,
	skillExtractorURL string,
	competenceMode string,
	modelID string,
	simulationMode bool,
	didRegistryDir string,
	didRegistryWaitTimeout time.Duration,
	observationTimeout time.Duration,
	logObservations bool,
	postObservations bool,
	trustDeltaBps int,
	trustedBeliefMinBps int,
	trustedUncertaintyMaxBps int,
	metricsDir string,
) error {
	if oracleID < 0 || oracleID >= n {
		return fmt.Errorf("oracle_id out of range: %d (n=%d)", oracleID, n)
	}
	if strings.TrimSpace(skillExtractorURL) == "" {
		return fmt.Errorf("skill_extractor_url is required in mode=oracle")
	}
	requestSource := requestSourceChain
	if strings.TrimSpace(contractRPCURL) == "" {
		return fmt.Errorf("contract_rpc_url is required in mode=oracle")
	}

	// runtime.ReadMemStats briefly stops/coordinates with the Go runtime. Ten
	// synchronized oracle tickers create artificial periodic spikes in a
	// causal simulation, while the external sampler already records resources.
	if !simulationMode {
		resourceCtx, stopResourceMetrics := context.WithCancel(ctx)
		resourceMetricsDone := make(chan struct{})
		go func() {
			defer close(resourceMetricsDone)
			logGoRuntimeMetrics(resourceCtx, oracleID)
		}()
		defer func() {
			stopResourceMetrics()
			<-resourceMetricsDone
		}()
	}

	startupDelay, err := oracleStartupDelay(oracleID)
	if err != nil {
		return err
	}
	if startupDelay > 0 {
		fmt.Printf("oracle=%d startupStagger=%s before CAVS identity setup\n", oracleID, startupDelay)
		timer := time.NewTimer(startupDelay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
	}

	registryEntry, err := setupOracleIdentityViaCAVS(ctx, skillExtractorURL, oracleID, didRegistryWaitTimeout)
	if err != nil {
		return err
	}
	if err := writeDIDRegistryEntry(didRegistryDir, registryEntry); err != nil {
		return fmt.Errorf("write did registry entry: %w", err)
	}

	registry, err := waitForDIDRegistryEntries(ctx, skillExtractorURL, didRegistryDir, n, didRegistryWaitTimeout)
	if err != nil {
		return err
	}

	cc, digester, err := waitForContractConfig(ctx, didRegistryDir, didRegistryWaitTimeout)
	if err != nil {
		return err
	}
	localContractConfigPath := oracleLocalContractConfigFile(oracleID)
	if err := writeContractConfigPath(localContractConfigPath, cc); err != nil {
		return fmt.Errorf("write local contract config copy: %w", err)
	}

	me, _, err := deriveNode(oracleID, oracleSeed, skillExtractorURL, registry[oracleID], nil)
	if err != nil {
		return err
	}
	onKR, fromAcct, err := newCAVSOnchainKeyring(oracleID, skillExtractorURL, registry[oracleID], registry)
	if err != nil {
		return err
	}

	p2pAnnounceResolved, err := resolveHostnamePortToIP(p2pAnnounce)
	if err != nil {
		return fmt.Errorf("resolve p2p_announce %q: %w", p2pAnnounce, err)
	}
	bootstrapAddrResolved, err := resolveHostnamePortToIP(bootstrapAddr)
	if err != nil {
		return fmt.Errorf("resolve bootstrap_addr %q: %w", bootstrapAddr, err)
	}

	var chainClient *noncentralizedclient.Client
	var requestRegistryAddress string
	localQueue := newRequestQueue()
	if strings.TrimSpace(contractAddress) == "" || strings.TrimSpace(requestRegistryAddress) == "" {
		deployment, err := waitForContractDeployment(ctx, didRegistryDir, didRegistryWaitTimeout)
		if err != nil {
			return err
		}
		if strings.TrimSpace(contractAddress) == "" {
			contractAddress = deployment.ContractAddress
		}
		requestRegistryAddress = deployment.RequestRegistryAddress
	}
	chainClient, err = noncentralizedclient.New(ctx, noncentralizedclient.Config{
		RPCURL:               contractRPCURL,
		ContractAddress:      contractAddress,
		CAVSURL:              skillExtractorURL,
		OracleID:             oracleID,
		DID:                  registryEntry.DID,
		OraclesEncryptionKey: me.offKR.OraclesEncryptionKey(),
	})
	if err != nil {
		return fmt.Errorf("init on-chain client: %w", err)
	}
	defer func() { _ = chainClient.Close() }()
	registrationResult, err := registerOracleWithRetry(ctx, chainClient, oracleID, didRegistryWaitTimeout)
	if err != nil {
		return fmt.Errorf("register oracle on chain: %w", err)
	}
	if registrationResult != nil && strings.TrimSpace(registrationResult.TransactionHash) != "" {
		if err := writeOracleRegistrationDeployment(didRegistryDir, oracleRegistrationDeployment{
			OracleID:        registrationResult.OracleID,
			Account:         registrationResult.Account,
			DID:             registrationResult.DID,
			TransactionHash: registrationResult.TransactionHash,
		}); err != nil {
			return fmt.Errorf("write oracle registration deployment metadata: %w", err)
		}
	}
	if strings.TrimSpace(requestRegistryAddress) == "" {
		return fmt.Errorf("contract mode requires request registry address in deployment metadata")
	}
	// Create the per-oracle metrics recorder early so the contract request
	// bridge can time its Sepolia/Alchemy event-poll RPC calls
	// (HeaderByNumber + FilterLogs) into the same per-oracle CSV used by
	// the OCR protocol phases.
	bridgeMetrics := newMetricRecorder(commontypes.OracleID(oracleID), competenceMode, modelID, metricsDir)
	// Drain buffered metric rows to disk off the OCR hot path, and guarantee a
	// final flush of whatever is still buffered when the oracle shuts down.
	if !simulationMode {
		bridgeMetrics.startFlusher()
	}
	defer bridgeMetrics.stop()
	bridgeCtx, stopBridge := context.WithCancel(ctx)
	bridgeDone, err := startContractRequestQueueBridge(
		bridgeCtx,
		contractRPCURL,
		common.HexToAddress(requestRegistryAddress),
		contractBeaconURL,
		queueURL,
		localQueue,
		oracleID,
		me.offKR.OraclesEncryptionPrivateKey(),
		bridgeMetrics,
	)
	if err != nil {
		stopBridge()
		return fmt.Errorf("start contract request bridge: %w", err)
	}
	// startContractRequestQueueBridge owns RPC clients in a background
	// goroutine. Cancel it on every runOracle exit path, including failures that
	// happen later while constructing the P2P/OCR stack.
	defer func() {
		stopBridge()
		<-bridgeDone
	}()
	queueLabel := strings.TrimSpace(queueURL)
	if queueLabel == "" {
		queueLabel = "embedded"
	}
	fmt.Printf("oracle=%d requestQueue=%s requestRegistry=%s registeredRequestEncryptionKey=true\n", oracleID, queueLabel, strings.TrimSpace(requestRegistryAddress))

	peer, err := networking.NewPeer(networking.PeerConfig{
		PrivKey:             me.offKR.offPriv,
		Logger:              quietLogger{log.New(os.Stdout, "", log.LstdFlags|log.Lmicroseconds)},
		V2ListenAddresses:   []string{p2pListen},
		V2AnnounceAddresses: []string{p2pAnnounceResolved},
		V2DeltaReconcile:    250 * time.Millisecond,
		V2DeltaDial:         250 * time.Millisecond,
		V2EndpointConfig: networking.EndpointConfigV2{
			IncomingMessageBufferSize: 100,
			OutgoingMessageBufferSize: 50,
		},
		MetricsRegisterer: prometheus.NewRegistry(),
	})
	if err != nil {
		return err
	}
	defer func() { _ = peer.Close() }()

	bootstrapPriv := deriveBootstrapPriv(seed)
	bootstrapPID, err := ragetypes.PeerIDFromPrivateKey(bootstrapPriv)
	if err != nil {
		return err
	}
	bootstrapLocator := commontypes.BootstrapperLocator{
		PeerID: bootstrapPID.String(),
		Addrs:  []string{bootstrapAddrResolved},
	}

	// Wiring for libocr:
	// - db persists protocol state (here in-memory)
	// - tracker provides the contract config (here static)
	// - monitoring/logger are stubs/quiet for readability
	db := &memDB3{}
	tracker := staticTracker{cfg: cc}
	monitoring := noopMonitoring{}
	logger := quietLogger{log.New(os.Stdout, "", log.LstdFlags|log.Lmicroseconds)}
	// Reuse the recorder created earlier for the contract request bridge so all
	// per-oracle metrics (OCR phases + EVENT_QUERY_HEADER/EVENT_QUERY_LOGS) go
	// to the same oracle_{id}_metrics.csv file.
	metrics := bridgeMetrics
	if metrics != nil && strings.TrimSpace(metrics.path) != "" {
		fmt.Printf("oracle=%d metricsCSV=%s metricsBackend=%s metricsModel=%s\n", oracleID, metrics.path, metrics.backend, metrics.modelID)
	}

	queueLabel = strings.TrimSpace(queueURL)
	if requestSource == requestSourceChain && queueLabel == "" {
		queueLabel = "embedded"
	}
	fmt.Printf("oracle=%d peerId=%s did=%s ethAddress=%s registry=%s localConfig=%s p2pListen=%s p2pAnnounce=%s skillExtractor=%s competenceMode=%s modelId=%s simulationMode=%t phaseSleeps=%s requestSource=%s queue=%s contractRPC=%s contractAddress=%s requestRegistry=%s bootstrap=%s configDigest=%s\n",
		oracleID, me.peerID, registryEntry.DID, fromAcct, didRegistryDir, localContractConfigPath, p2pListen, p2pAnnounceResolved, skillExtractorURL, strings.TrimSpace(competenceMode), strings.TrimSpace(modelID), simulationMode, configuredPhaseSleeps.String(), requestSource, queueLabel, redactURLForLog(contractRPCURL), strings.TrimSpace(contractAddress), strings.TrimSpace(requestRegistryAddress), bootstrapAddrResolved, cc.ConfigDigest.Hex())

	pluginFactory := cavsPluginFactory{
		queueURL:          queueURL,
		localQueue:        localQueue,
		requestSource:     requestSource,
		skillExtractorURL: skillExtractorURL,
		competenceMode:    competenceMode,
		simulationMode:    simulationMode,
		// Enforce the same bound at the HTTP client boundary. libocr supplies a
		// callback context, but the transport must not be allowed to outlive the
		// configured OCR observation phase if that context lacks a deadline.
		observationTimeout: observationTimeout,
		requestImportWait:  defaultRequestImportWaitTimeout,
		logObservations:    logObservations,
		postObservations:   postObservations,
		trustDIDs:          registryDIDs(registry),
		metrics:            metrics,
	}

	transmitTimeout := 10 * time.Minute
	tx := &logTransmitter{
		oracleID:             commontypes.OracleID(oracleID),
		from:                 fromAcct,
		queueURL:             queueURL,
		localQueue:           localQueue,
		requestSource:        requestSource,
		http:                 &http.Client{Timeout: transmitTimeout},
		relayFailures:        map[string]int{},
		metrics:              metrics,
		f:                    cc.F,
		n:                    n,
		cavsEndpointTemplate: strings.TrimSpace(os.Getenv("OCR_SIGNER_CAVS_ENDPOINT_TEMPLATE")),
	}

	// OCR3OracleArgs is the main dependency injection point for libocr.
	// The important pieces:
	// - p2p endpoint factory (ragep2p)
	// - config tracker + digester
	// - keyrings (offchain + onchain)
	// - plugin factory (your app logic)
	// - contract transmitter (how reports are "sent")
	args := offchainreporting2plus.OCR3OracleArgs[struct{}]{
		BinaryNetworkEndpointFactory: peer.OCR2BinaryNetworkEndpointFactory(),
		V2Bootstrappers:              []commontypes.BootstrapperLocator{bootstrapLocator},
		ContractConfigTracker:        tracker,
		ContractTransmitter:          tx,
		Database:                     db,
		LocalConfig: types.LocalConfig{
			// Dev mode relaxes some production safeguards; good for local testing,
			// not appropriate for real money / real contracts.
			DevelopmentMode:                    types.EnableDangerousDevelopmentMode,
			BlockchainTimeout:                  5 * time.Second,
			ContractConfigConfirmations:        1,
			ContractConfigTrackerPollInterval:  5 * time.Second,
			ContractConfigLoadTimeout:          30 * time.Second,
			ContractTransmitterTransmitTimeout: transmitTimeout,
			DatabaseTimeout:                    1 * time.Second,
			DefaultMaxDurationInitialization:   30 * time.Second,
		},
		Logger:                 logger,
		MetricsRegisterer:      prometheus.NewRegistry(),
		MonitoringEndpoint:     monitoring,
		OffchainConfigDigester: digester,
		OffchainKeyring:        me.offKR,
		OnchainKeyring:         onKR,
		ReportingPluginFactory: pluginFactory,
	}

	oracle, err := offchainreporting2plus.NewOracle(args)
	if err != nil {
		return err
	}
	if err := oracle.Start(); err != nil {
		return err
	}
	defer func() { _ = oracle.Close() }()

	fmt.Printf("[ORACLE-READY] oracle=%d simulationMode=%t requestBridge=running\n", oracleID, simulationMode)
	select {
	case <-ctx.Done():
		return nil
	case bridgeErr := <-bridgeDone:
		// Cancellation closes the bridge as part of an ordinary shutdown. If
		// both select cases become ready together, selecting bridgeDone must not
		// turn SIGTERM/Compose teardown into a spurious oracle failure.
		if ctx.Err() != nil {
			return nil
		}
		if bridgeErr == nil {
			return fmt.Errorf("contract request bridge stopped unexpectedly")
		}
		return fmt.Errorf("contract request bridge failed: %w", bridgeErr)
	}
}

// main parses flags and runs either the bootstrapper or an oracle node.
//
// For docker-compose usage you usually start:
// - 1x queue (separate cavs-queue binary)
// - 1x bootstrap
// - Nx oracle (oracle_id=0..n-1)
func main() {
	seedDefault, seedFromEnv, err := envInt64("OCR_SEED")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	oracleSeedDefault, oracleSeedFromEnv, err := envInt64("OCR_ORACLE_SEED")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	oracleSeedsDefault, oracleSeedsFromEnv := envString("OCR_ORACLE_SEEDS")
	trustEnabledDefault, _, err := envBool("OCR_TRUST_ENABLED")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	simulationModeDefault, _, err := envBool("OCR_SIMULATION_MODE")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	phaseSleeps, err := loadPhaseSleepConfig()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	configuredPhaseSleeps = phaseSleeps

	var (
		mode string

		n              int
		f              int
		oracleID       int
		seed           int64
		oracleSeed     int64
		oracleSeedsCSV string

		queueURL             string
		contractRPCURL       string
		contractBeaconURL    string
		contractAddress      string
		oraclePublicEndpoint string

		bootstrapListen   string
		bootstrapAnnounce string
		bootstrapAddr     string
		didRegistryDir    string

		p2pListen   string
		p2pAnnounce string

		skillExtractorURL string
		competenceMode    string
		modelID           string
		simulationMode    bool

		logObservations  bool
		postObservations bool
		metricsDir       string

		trustEnabled             bool
		trustDeltaBps            int
		trustedBeliefMinBps      int
		trustedUncertaintyMaxBps int
		observationQuorumMode    string
		didRegistryWaitTimeout   time.Duration
		rMax                     uint
	)
	timing := defaultOCRTimingConfig(200 * time.Millisecond)
	rMax = uint(timing.RMax)

	flag.StringVar(&mode, "mode", "oracle", "bootstrap|oracle")
	flag.IntVar(&n, "n", 4, "number of oracles")
	flag.IntVar(&f, "f", 1, "fault tolerance")
	flag.IntVar(&oracleID, "oracle_id", 0, "oracle id (0..n-1) for mode=oracle")
	flag.Int64Var(&seed, "seed", seedDefault, "shared deployment seed for bootstrap peer identity and OCR config randomness (must match bootstrap and all oracles; can also come from OCR_SEED)")
	flag.Int64Var(&oracleSeed, "oracle_seed", oracleSeedDefault, "per-oracle seed for offchain/config private keys (mode=oracle; can also come from OCR_ORACLE_SEED)")
	flag.StringVar(&oracleSeedsCSV, "oracle_seeds", oracleSeedsDefault, "comma-separated per-oracle seeds for OCR identities (mode=bootstrap; can also come from OCR_ORACLE_SEEDS)")

	flag.StringVar(&queueURL, "queue_url", "http://queue:20000", "optional queue base url for observation/result visibility; empty keeps the queue embedded in each oracle")
	flag.StringVar(&contractRPCURL, "contract_rpc_url", "", "RPC URL for the smart-contract backend (mode=bootstrap/oracle; bootstrap auto-deploys when this is set and contract_address is empty)")
	flag.StringVar(&contractBeaconURL, "contract_beacon_url", "", "Beacon API URL for retrieving EIP-4844 blob sidecars (mode=oracle); if empty, the oracle will try to derive it from known RPC hosts and otherwise fall back to the shared blob cache")
	flag.StringVar(&contractAddress, "contract_address", "", "smart contract address for the non-centralized backend (mode=bootstrap/oracle; optional when bootstrap auto-deploys)")
	flag.StringVar(&oraclePublicEndpoint, "oracle_public_endpoint", "", "deprecated: public queue endpoint is no longer stored on-chain")

	flag.StringVar(&bootstrapListen, "bootstrap_listen", "0.0.0.0:19900", "bootstrap listen address (mode=bootstrap)")
	flag.StringVar(&bootstrapAnnounce, "bootstrap_announce", "bootstrap:19900", "bootstrap announce address (mode=bootstrap)")
	flag.StringVar(&bootstrapAddr, "bootstrap_addr", "bootstrap:19900", "bootstrap address for oracles to dial (mode=oracle)")
	flag.StringVar(&didRegistryDir, "did_registry_dir", "/registry", "shared directory that stores one DID registry file per oracle")

	flag.StringVar(&p2pListen, "p2p_listen", "0.0.0.0:20010", "oracle p2p listen address (mode=oracle)")
	flag.StringVar(&p2pAnnounce, "p2p_announce", "", "oracle p2p announce address (mode=oracle); default oracle{ID}:20010")

	flag.StringVar(&skillExtractorURL, "skill_extractor_url", "", "base url for CAVS extractor/competence endpoint and DID/address resolution (mode=oracle/bootstrap)")
	flag.StringVar(&competenceMode, "competence_mode", "", "optional competence mode forwarded to CAVS /extract (e.g. gpt); empty uses CAVS default")
	flag.StringVar(&modelID, "model_id", "", "stable model identifier recorded separately from the competence backend family")
	flag.BoolVar(&simulationMode, "simulation_mode", simulationModeDefault, "replace external model inference with a deterministic observation for causal phase-isolation experiments (can also come from OCR_SIMULATION_MODE)")
	flag.BoolVar(&logObservations, "log_observations", true, "print each oracle's Observation() output (skills)")
	flag.BoolVar(&postObservations, "post_observations", true, "persist each oracle's observation to the active request backend (queue or contract)")
	flag.StringVar(&metricsDir, "metrics_dir", "timings", "append OCR timing CSV files here, one file per oracle; empty disables CSV metrics")
	flag.BoolVar(&trustEnabled, "trust_enabled", trustEnabledDefault, "enable trust-weighted aggregation and replicated trust state (mode=bootstrap; can also come from OCR_TRUST_ENABLED)")
	flag.IntVar(&trustDeltaBps, "trust_delta_bps", 10, "positive evidence threshold distance to aggregate confidence on the 0..100 trust scale (uncertain up to 2x)")
	flag.IntVar(&trustedBeliefMinBps, "trusted_belief_min_bps", 51, "trusted-set criterion on the 0..100 trust scale: belief >= this value")
	flag.IntVar(&trustedUncertaintyMaxBps, "trusted_uncertainty_max_bps", 49, "trusted-set criterion on the 0..100 trust scale: uncertainty <= this value")
	observationQuorumDefault, _ := envString("OCR_OBSERVATION_QUORUM")
	if strings.TrimSpace(observationQuorumDefault) == "" {
		observationQuorumDefault = quorumModeTwoFPlusOne
	}
	flag.StringVar(&observationQuorumMode, "observation_quorum", observationQuorumDefault, "observation quorum rule (mode=bootstrap; can also come from OCR_OBSERVATION_QUORUM): 'two_f_plus_one' (default, BFT-live) or 'all' (strict unanimity: waits for every model but a single unavailable node halts every round)")
	flag.DurationVar(&didRegistryWaitTimeout, "did_registry_wait_timeout", 5*time.Minute, "maximum time to wait for all DID registry files before starting OCR")
	flag.DurationVar(&timing.DeltaGrace, "delta_grace", timing.DeltaGrace, "OCR3 grace period after observation quorum before report generation (mode=bootstrap); with observation_quorum=two_f_plus_one, raise this so the remaining honest observations still arrive before the outcome is proposed; with observation_quorum=all it can stay near-zero since the quorum already waits for every node")
	flag.DurationVar(&timing.DeltaRound, "delta_round", timing.DeltaRound, "OCR3 minimum interval between round starts (mode=bootstrap); lower speeds healthy pipelines but must still cover message round-trips")
	flag.DurationVar(&timing.DeltaProgress, "delta_progress", timing.DeltaProgress, "OCR3 pacemaker progress timeout before requesting a new epoch/leader (mode=bootstrap); must exceed max_dur_obs + delta_round")
	flag.DurationVar(&timing.DeltaResend, "delta_resend", timing.DeltaResend, "OCR3 NewEpochWish resend interval (mode=bootstrap)")
	flag.DurationVar(&timing.DeltaInitial, "delta_initial", timing.DeltaInitial, "OCR3 initial round-start wait before requesting a new epoch/leader (mode=bootstrap)")
	flag.DurationVar(&timing.DeltaCertifiedCommitRequest, "delta_certified_commit_request", timing.DeltaCertifiedCommitRequest, "OCR3 certified-commit retry interval for report attestation (mode=bootstrap)")
	flag.DurationVar(&timing.DeltaStage, "delta_stage", timing.DeltaStage, "OCR3 transmission schedule stage interval (mode=bootstrap)")
	flag.UintVar(&rMax, "r_max", rMax, "OCR3 maximum rounds in one epoch before changing leader (mode=bootstrap)")
	flag.DurationVar(&timing.MaxDurationQuery, "max_dur_query", timing.MaxDurationQuery, "maximum plugin Query duration (mode=bootstrap)")
	flag.DurationVar(&timing.MaxDurationObservation, "max_dur_obs", timing.MaxDurationObservation, "maximum plugin Observation duration (mode=bootstrap)")
	flag.DurationVar(&timing.MaxDurationShouldAcceptAttestedReport, "max_dur_accept", timing.MaxDurationShouldAcceptAttestedReport, "maximum ShouldAcceptAttestedReport duration (mode=bootstrap)")
	flag.DurationVar(&timing.MaxDurationShouldTransmitAcceptedReport, "max_dur_transmit", timing.MaxDurationShouldTransmitAcceptedReport, "maximum ShouldTransmitAcceptedReport duration (mode=bootstrap)")
	flag.Parse()
	if rMax == 0 || rMax > 255 {
		fmt.Fprintf(os.Stderr, "invalid r_max=%d: must be between 1 and 255\n", rMax)
		os.Exit(2)
	}
	timing.RMax = uint64(rMax)

	if !seedFromEnv && !flagWasSet("seed") {
		fmt.Fprintln(os.Stderr, "missing deployment seed: set -seed or OCR_SEED")
		os.Exit(2)
	}

	if p2pAnnounce == "" && mode == "oracle" {
		p2pAnnounce = "oracle" + strconv.Itoa(oracleID) + ":20010"
	}
	trustDeltaBps = clampInt(trustDeltaBps, 0, trustScale)
	trustedBeliefMinBps = clampInt(trustedBeliefMinBps, 0, trustScale)
	trustedUncertaintyMaxBps = clampInt(trustedUncertaintyMaxBps, 0, trustScale)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch mode {
	case "bootstrap":
		if !oracleSeedsFromEnv && !flagWasSet("oracle_seeds") {
			fmt.Fprintln(os.Stderr, "missing oracle seed list: set -oracle_seeds or OCR_ORACLE_SEEDS")
			os.Exit(2)
		}
		oracleSeeds, err := parseInt64CSV(oracleSeedsCSV, n)
		if err != nil {
			must(fmt.Errorf("parse oracle_seeds: %w", err))
		}
		must(validateDistinctInt64s("oracle_seeds", oracleSeeds))
		must(runBootstrap(ctx, n, f, seed, oracleSeeds, bootstrapListen, bootstrapAnnounce, skillExtractorURL, contractRPCURL, contractAddress, didRegistryDir, didRegistryWaitTimeout, timing, trustEnabled, trustDeltaBps, trustedBeliefMinBps, trustedUncertaintyMaxBps, observationQuorumMode))
	case "oracle":
		if !oracleSeedFromEnv && !flagWasSet("oracle_seed") {
			fmt.Fprintln(os.Stderr, "missing oracle seed: set -oracle_seed or OCR_ORACLE_SEED")
			os.Exit(2)
		}
		must(runOracle(ctx, oracleID, n, f, seed, oracleSeed, queueURL, contractRPCURL, contractBeaconURL, contractAddress, oraclePublicEndpoint, bootstrapAddr, p2pListen, p2pAnnounce, skillExtractorURL, competenceMode, modelID, simulationMode, didRegistryDir, didRegistryWaitTimeout, timing.MaxDurationObservation, logObservations, postObservations, trustDeltaBps, trustedBeliefMinBps, trustedUncertaintyMaxBps, metricsDir))
	default:
		must(fmt.Errorf("unknown mode: %q", mode))
	}
}
