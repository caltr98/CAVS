//go:build !queue

// This file is the entrypoint for the oracle/bootstrap binary ("cavs-oracle").
//
// The queue node is a separate binary built with `-tags queue` ("cavs-queue").
//
// How the OCR3 pipeline maps to THIS file:
//
//  1. "Query" phase (leader only):
//     cavsPlugin.Query() fetches a pending request from the selected backend:
//     the shared queue in centralized mode or the leader's per-oracle queue
//     sidecar in contract/registry mode.
//     Leader broadcasts it as MessageRoundStart{Query} (handled inside libocr).
//
//  2. "Observation" phase (all oracles):
//     cavsPlugin.Observation() calls the skill extractor and produces a byte
//     slice (types.Observation). Followers sign it and send MessageObservation
//     to the leader (handled inside libocr).
//
//  3. "Outcome" phase (all oracles, deterministic):
//     cavsPlugin.Outcome() aggregates the attributed observations into a single
//     ocr3types.Outcome (here: median-per-skill with 2f+1 support).
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
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	noncentralizedclient "cavs/cavsonocr/Oracle/noncentralized/client"
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
	"github.com/smartcontractkit/libocr/quorumhelper"
	ragetypes "github.com/smartcontractkit/libocr/ragep2p/types"
)

const (
	fixedTrustEpochLen = 1
	fixedSkillsTopK    = 50
	trustScale         = 100
	requestSourceQueue = "queue"
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

// ReadConfig returns the latest contract config the protocol should run with.
// In a real deployment this would come from chain (via ContractConfigTracker)
// and be persisted in a durable DB.
func (m *memDB3) ReadConfig(context.Context) (*types.ContractConfig, error) { return m.cfg, nil }

// WriteConfig stores the current contract config.
func (m *memDB3) WriteConfig(_ context.Context, c types.ContractConfig) error {
	m.cfg = &c
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

func resolveDIDEthAddressViaCAVS(client *http.Client, cavsURL string, did string) (string, error) {
	did = strings.TrimSpace(did)
	if did == "" {
		return "", fmt.Errorf("empty did")
	}
	var resp struct {
		OK         bool   `json:"ok"`
		DID        string `json:"did"`
		EthAddress string `json:"eth_address"`
	}
	if err := httpPostJSON(client, strings.TrimRight(cavsURL, "/")+"/identity/resolve", map[string]any{
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

func onchainAddressKey(pubkey types.OnchainPublicKey) string {
	return strings.ToLower(common.BytesToAddress(pubkey).Hex())
}

// PublicKey returns the Ethereum address bytes that libocr uses as the onchain
// identity for this oracle.
func (k *cavsOnchainKeyring) PublicKey() types.OnchainPublicKey {
	addr, err := resolveDIDEthAddressViaCAVS(k.http, k.cavsURL, k.did)
	if err != nil {
		return nil
	}
	pub := common.HexToAddress(addr).Bytes()
	out := make([]byte, len(pub))
	copy(out, pub)
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
	from := types.Account(addr)
	registryByAddress := make(map[string]didRegistryEntry, len(registry))
	for _, entry := range registry {
		addr, err := resolveDIDEthAddressViaCAVS(client, cavsURL, entry.DID)
		if err != nil {
			return nil, "", fmt.Errorf("registry oracle %d: %w", entry.OracleID, err)
		}
		key := strings.ToLower(addr)
		if existing, ok := registryByAddress[key]; ok && existing.DID != entry.DID {
			return nil, "", fmt.Errorf("duplicate onchain address %s for DIDs %s and %s", key, existing.DID, entry.DID)
		}
		registryByAddress[key] = entry
	}
	return &cavsOnchainKeyring{
		oracleID:          oracleID,
		cavsURL:           cavsURL,
		did:               me.DID,
		registryByAddress: registryByAddress,
		http:              client,
	}, from, nil
}

type offchainKeyring struct {
	offPriv ed25519.PrivateKey
	cfgPriv [32]byte
	cfgPub  [32]byte
}

// newOffchainKeyringGeneration derives an oracle's offchain+config keypair
// from that oracle's own seed and oracleID.
//
// oracleSeed must be unique per oracle. oracleID is still mixed in for domain
// separation so the same numeric seed reused across two IDs does not collide.
func newOffchainKeyringGeneration(oracleSeed int64, oracleID int) (*offchainKeyring, error) {
	offSeed := sha256.Sum256([]byte(fmt.Sprintf("offchain|%d|%d", oracleSeed, oracleID)))
	offPriv := ed25519.NewKeyFromSeed(offSeed[:])

	cfgSeed := sha256.Sum256([]byte(fmt.Sprintf("cfg|%d|%d", oracleSeed, oracleID)))
	var cfgPriv [32]byte
	copy(cfgPriv[:], cfgSeed[:])

	privateKey, err := ecdh.X25519().NewPrivateKey(cfgPriv[:])
	if err != nil {
		return nil, err
	}
	var cfgPubArr [32]byte
	copy(cfgPubArr[:], privateKey.PublicKey().Bytes())
	return &offchainKeyring{offPriv: offPriv, cfgPriv: cfgPriv, cfgPub: cfgPubArr}, nil
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
	copy(r[:], out)
	return r, err
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

// pluginConfig is (part of) the OCR3 offchain config for the ReportingPlugin.
// It is broadcast to all nodes through the contract config and must be identical
// everywhere to keep the protocol deterministic.
type pluginConfig struct {
	// TrustDeltaBps is the score distance threshold on the 0..100 trust scale used to
	// classify positive/uncertain/negative evidence relative to the median.
	// Example: 10 => +/-0.10.
	TrustDeltaBps int `json:"trustDeltaBps,omitempty"`
	// TrustedBeliefMinBps and TrustedUncertaintyMaxBps define whether an oracle
	// is considered trusted for the next epoch's median calculations.
	TrustedBeliefMinBps      int `json:"trustedBeliefMinBps,omitempty"`
	TrustedUncertaintyMaxBps int `json:"trustedUncertaintyMaxBps,omitempty"`
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
}

// cavsPluginFactory implements ocr3types.ReportingPluginFactory.
//
// libocr calls NewReportingPlugin once per oracle process (and potentially again
// on restart). The plugin contains your application logic for Query/Observation/
// Outcome/Reports.
type cavsPluginFactory struct {
	queueURL           string
	requestSource      string
	skillExtractorURL  string
	competenceMode     string
	observationTimeout time.Duration
	logObservations    bool
	postObservations   bool
	trustDIDs          []string
}

// NewReportingPlugin constructs the per-oracle plugin instance and declares
// plugin "limits" (max byte sizes) used by libocr for validation/rate limiting.
func (f cavsPluginFactory) NewReportingPlugin(_ context.Context, cfg ocr3types.ReportingPluginConfig) (ocr3types.ReportingPlugin[struct{}], ocr3types.ReportingPluginInfo, error) {
	pc := pluginConfig{}
	if len(cfg.OffchainConfig) != 0 {
		_ = json.Unmarshal(cfg.OffchainConfig, &pc)
	}
	pc.normalize()
	p := &cavsPlugin{
		cfg:                cfg,
		pc:                 pc,
		queueURL:           strings.TrimRight(f.queueURL, "/"),
		requestSource:      strings.TrimSpace(f.requestSource),
		skillExtractorURL:  strings.TrimRight(f.skillExtractorURL, "/"),
		competenceMode:     strings.TrimSpace(f.competenceMode),
		observationTimeout: f.observationTimeout,
		logObservations:    f.logObservations,
		postObservations:   f.postObservations,
		trustDIDs:          append([]string(nil), f.trustDIDs...),
		http:               &http.Client{Timeout: f.observationTimeout},
	}
	info := ocr3types.ReportingPluginInfo{
		Name: "gpt-comp-checker-vector-median-trust", //Customized median trust
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
	requestSource      string
	skillExtractorURL  string
	competenceMode     string
	observationTimeout time.Duration
	logObservations    bool
	postObservations   bool
	trustDIDs          []string
	http               *http.Client
}

func oracleIsTargeted(oracleID int, targetOracleIDs []int) bool {
	if len(targetOracleIDs) == 0 {
		return true
	}
	for _, candidate := range targetOracleIDs {
		if candidate == oracleID {
			return true
		}
	}
	return false
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

// weightedMedian returns the weighted median score.
// If all weights are zero, it falls back to the unweighted (upper) median.
func weightedMedian(in []weightedScore) float64 {
	if len(in) == 0 {
		return 0
	}
	total := uint32(0)
	for _, x := range in {
		total += x.Weight
	}
	sort.Slice(in, func(i, j int) bool {
		if in[i].Score != in[j].Score {
			return in[i].Score < in[j].Score
		}
		return in[i].Oracle < in[j].Oracle
	})
	if total == 0 {
		return in[len(in)/2].Score
	}
	threshold := (total + 1) / 2
	cum := uint32(0)
	for _, x := range in {
		cum += x.Weight
		if cum >= threshold {
			return x.Score
		}
	}
	return in[len(in)-1].Score
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

// Query is called by the round leader to build a query that will be broadcast
// to all other oracles for this seqNr.
//
// In many real OCR3 deployments, Query is empty and all oracles independently
// observe the world. Here we use Query to "assign work": the leader asks the
// active backend for the next request and puts it in the Query bytes.
func (p *cavsPlugin) Query(ctx context.Context, _ ocr3types.OutcomeContext) (types.Query, error) {
	switch p.requestSource {
	case "", requestSourceQueue:
		if p.queueURL == "" {
			return nil, nil
		}
		q, ok, err := getCurrentRequestFromQueue(ctx, p.http, p.queueURL)
		if err != nil {
			fmt.Printf("QUERY oracle=%d error=%v\n", p.cfg.OracleID, err)
			return nil, err
		}
		if !ok {
			return nil, nil
		}
		if q.RequestID == "" || strings.TrimSpace(q.Statement) == "" {
			return nil, nil
		}
		fmt.Printf("QUERY oracle=%d picked requestId=%s\n", p.cfg.OracleID, q.RequestID)
		b, err := json.Marshal(q)
		if err != nil {
			return nil, err
		}
		return types.Query(b), nil
	case requestSourceChain:
		if p.queueURL == "" {
			return nil, fmt.Errorf("request_source=contract but queue_url is empty")
		}
		request, ok, err := getCurrentRequestFromQueue(ctx, p.http, p.queueURL)
		if err != nil {
			fmt.Printf("QUERY oracle=%d error=%v\n", p.cfg.OracleID, err)
			return nil, err
		}
		if !ok || request.RequestID == "" || strings.TrimSpace(request.Statement) == "" {
			return nil, nil
		}
		fmt.Printf("QUERY oracle=%d picked requestId=%s source=contract-local-queue\n", p.cfg.OracleID, request.RequestID)
		b, err := json.Marshal(request)
		if err != nil {
			return nil, err
		}
		return types.Query(b), nil
	default:
		return nil, fmt.Errorf("unsupported request_source %q", p.requestSource)
	}
}

// Observation is called on every oracle after it receives the leader's Query.
//
// This is where each oracle contacts the external data source (the skill
// extractor service) and returns opaque bytes to libocr. libocr will:
// - sign the observation (offchain key)
// - send it to the leader
// - validate/aggregate it according to your other plugin methods
func (p *cavsPlugin) Observation(ctx context.Context, outctx ocr3types.OutcomeContext, query types.Query) (types.Observation, error) {
	var q queryPayload
	if len(query) > 0 {
		if err := json.Unmarshal(query, &q); err != nil {
			return nil, fmt.Errorf("bad query json: %w", err)
		}
	}

	participating := oracleIsTargeted(int(p.cfg.OracleID), q.TargetOracleIDs)

	if len(query) == 0 || p.skillExtractorURL == "" {
		b, err := json.Marshal(observationPayload{
			Skills:        []simSkill{},
			AuthorSkills:  q.AuthorSkills,
			Participating: false,
		})
		if err != nil {
			return nil, err
		}
		return types.Observation(b), nil
	}

	if p.requestSource == requestSourceChain {
		if p.queueURL == "" {
			return nil, fmt.Errorf("request_source=contract but queue_url is empty")
		}
		localRequest, ok, err := getStoredRequestFromQueue(ctx, p.http, p.queueURL, q.RequestID)
		if err != nil {
			return nil, fmt.Errorf("lookup local queued request %s: %w", q.RequestID, err)
		}
		if !ok {
			if p.postObservations {
				p.postObservationBestEffort(ctx, q.RequestID, outctx.SeqNr, nil, q.AuthorSkills, true, false, 1.0, "did not share")
			}
			if p.logObservations {
				fmt.Printf("OBS oracle=%d seqNr=%d requestId=%s participating=true competent=false conf=1.00 reason=did not share\n", p.cfg.OracleID, outctx.SeqNr, q.RequestID)
			}
			b, err := json.Marshal(observationPayload{
				Skills:        nil,
				AuthorSkills:  nil,
				Participating: true,
				Competent:     false,
				Confidence:    1.0,
				Reason:        "did not share",
			})
			if err != nil {
				return nil, err
			}
			return types.Observation(b), nil
		}
		q = localRequest
		participating = true
	}

	if p.requestSource != requestSourceChain && !participating {
		if p.postObservations {
			p.postObservationBestEffort(ctx, q.RequestID, outctx.SeqNr, nil, q.AuthorSkills, false, false, 0, "oracle not targeted by request")
		}
		if p.logObservations {
			fmt.Printf("OBS oracle=%d seqNr=%d requestId=%s participating=false reason=oracle not targeted by request\n", p.cfg.OracleID, outctx.SeqNr, q.RequestID)
		}
		b, err := json.Marshal(observationPayload{
			Skills:        nil,
			AuthorSkills:  nil,
			Participating: false,
			Competent:     false,
			Confidence:    0,
			Reason:        "oracle not targeted by request",
		})
		if err != nil {
			return nil, err
		}
		return types.Observation(b), nil
	}

	requestPayload := map[string]any{
		"text":         q.Statement,
		"authorSkills": q.AuthorSkills,
	}
	if mode := strings.TrimSpace(p.competenceMode); mode != "" {
		requestPayload["competenceMode"] = mode
	}
	body, _ := json.Marshal(requestPayload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.skillExtractorURL+"/extract", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := p.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("skill extractor http %d", resp.StatusCode)
	}

	var responsePayload map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&responsePayload); err != nil {
		return nil, err
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
		p.postObservationBestEffort(ctx, q.RequestID, outctx.SeqNr, nil, q.AuthorSkills, true, comp, conf, reason)
	}
	if p.logObservations {
		fmt.Printf("OBS oracle=%d seqNr=%d requestId=%s participating=true competent=%t conf=%.2f reason=%s\n", p.cfg.OracleID, outctx.SeqNr, q.RequestID, comp, conf, reason)
	}

	b, err := json.Marshal(observationPayload{
		Skills:        nil,
		AuthorSkills:  nil,
		Participating: true,
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
func (p *cavsPlugin) ValidateObservation(context.Context, ocr3types.OutcomeContext, types.Query, types.AttributedObservation) error {
	return nil
}

// postObservationBestEffort posts an oracle's observation to the queue for
// debugging/visibility. OCR3 does not require this; failures here should not
// impact the protocol, hence the best-effort behavior.
func (p *cavsPlugin) postObservationBestEffort(ctx context.Context, requestID string, seqNr uint64, skills []simSkill, authorSkills []string, participating bool, comp bool, conf float64, reason string) {
	switch p.requestSource {
	case "", requestSourceQueue:
		if p.queueURL == "" || requestID == "" {
			return
		}
		err := postObservationToQueue(ctx, p.http, p.queueURL, requestID, storedObservation{
			OracleID:      int(p.cfg.OracleID),
			SeqNr:         seqNr,
			Skills:        skills,
			AuthorSkills:  authorSkills,
			Participating: participating,
			Competent:     comp,
			Confidence:    conf,
			Reason:        reason,
		})
		if err != nil {
			return
		}
	case requestSourceChain:
		if p.queueURL == "" || requestID == "" {
			return
		}
		err := postObservationToQueue(ctx, p.http, p.queueURL, requestID, storedObservation{
			OracleID:      int(p.cfg.OracleID),
			SeqNr:         seqNr,
			Skills:        skills,
			AuthorSkills:  authorSkills,
			Participating: participating,
			Competent:     comp,
			Confidence:    conf,
			Reason:        reason,
		})
		if err != nil {
			return
		}
	}
}

// ObservationQuorum decides when the leader has enough valid observations to
// propose an outcome. The default OCR2-style rule is "2f+1 observations".
//
// With n=4, f=1 this means 3 valid observations are required to proceed.
func (p *cavsPlugin) ObservationQuorum(_ context.Context, _ ocr3types.OutcomeContext, _ types.Query, attributedObservations []types.AttributedObservation) (bool, error) {
	return quorumhelper.ObservationCountReachesObservationQuorum(quorumhelper.QuorumTwoFPlusOne, p.cfg.N, p.cfg.F, attributedObservations), nil
}

// Outcome deterministically aggregates the attributed observations into a single
// byte blob (ocr3types.Outcome).
//
// Determinism requirement (critical):
//   - Every honest oracle must compute identical Outcome bytes for a given input,
//     otherwise later report signatures will not verify and the round will fail.
func (p *cavsPlugin) Outcome(_ context.Context, outctx ocr3types.OutcomeContext, query types.Query, attributedObservations []types.AttributedObservation) (ocr3types.Outcome, error) {
	trust := decodePreviousTrust(outctx.PreviousOutcome, p.cfg.N, p.trustDIDs)
	trust.Trusted = computeTrusted(trust.Running, p.pc.TrustedBeliefMinBps, p.pc.TrustedUncertaintyMaxBps)

	var q queryPayload
	if len(query) != 0 {
		if err := json.Unmarshal(query, &q); err != nil {
			return nil, fmt.Errorf("bad query json: %w", err)
		}
	}
	if q.RequestID == "" {
		// carry trust forward even if no request
		b, err := json.Marshal(outcomePayload{Trust: trust})
		if err != nil {
			return nil, err
		}
		return ocr3types.Outcome(b), nil
	}
	statementHash := statementHashHex(q.Statement)

	sort.Slice(attributedObservations, func(i, j int) bool { return attributedObservations[i].Observer < attributedObservations[j].Observer })

	type obsResult struct {
		observer commontypes.OracleID
		comp     bool
		conf     float64
		reason   string
		weight   uint32
	}

	results := make([]obsResult, 0, len(attributedObservations))
	for _, ao := range attributedObservations {
		var op observationPayload
		if err := json.Unmarshal(ao.Observation, &op); err != nil {
			continue
		}
		if !op.Participating {
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
		idx := int(ao.Observer)
		if idx >= 0 && idx < len(trust.Running) {
			w = trustWeightBps(trust.Running[idx])
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
			RequesterEndpoint: q.RequesterEndpoint,
			Statement:         q.Statement,
			StatementHash:     statementHash,
			HolderDID:         q.HolderDID,
			Skills:            []simSkill{},
			Competent:         false,
			Confidence:        0,
			Reason:            "no participating observations",
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

	// weighted median of confidence over observations aligned with the aggregate competence.
	confVals := make([]weightedScore, 0, len(alignedResults))
	for _, r := range alignedResults {
		confVals = append(confVals, weightedScore{Score: r.conf, Weight: r.weight, Oracle: r.observer})
	}
	aggConf := weightedMedian(confVals)

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

	bestReason := "no reason provided"
	bestDelta := math.MaxFloat64
	var bestOracle commontypes.OracleID
	bestSet := false
	for _, r := range alignedResults {
		rz := r.reason
		if strings.TrimSpace(rz) == "" {
			rz = "no reason provided"
		}
		delta := math.Abs(r.conf - aggConf)
		if delta < bestDelta || (!bestSet) || (delta == bestDelta && r.observer < bestOracle) {
			bestDelta = delta
			bestOracle = r.observer
			bestReason = rz
			bestSet = true
		}
	}

	out := outcomePayload{
		RequestID:         q.RequestID,
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
	return ocr3types.Outcome(b), nil
}

// Reports converts the agreed Outcome into one or more reports to be signed and
// (maybe) transmitted.
//
// Here the report bytes are exactly equal to the outcome bytes.
func (p *cavsPlugin) Reports(_ context.Context, _ uint64, outcome ocr3types.Outcome) ([]ocr3types.ReportPlus[struct{}], error) {
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
func (p *cavsPlugin) ShouldAcceptAttestedReport(_ context.Context, _ uint64, report ocr3types.ReportWithInfo[struct{}]) (bool, error) {
	if p.requestSource == requestSourceChain && p.queueURL != "" {
		var out outcomePayload
		if err := json.Unmarshal(report.Report, &out); err == nil && strings.TrimSpace(out.RequestID) != "" {
			if err := postCompletionToQueue(context.Background(), p.http, p.queueURL, out.RequestID); err != nil {
				fmt.Printf("queue post completion error requestId=%s err=%v\n", out.RequestID, err)
			}
		}
	}
	return true, nil
}

// ShouldTransmitAcceptedReport is called right before transmission.
// Returning true means "actually transmit now (subject to the schedule)".
func (p *cavsPlugin) ShouldTransmitAcceptedReport(context.Context, uint64, ocr3types.ReportWithInfo[struct{}]) (bool, error) {
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
	requestSource string
	http          *http.Client
	vcIssuerURL   string
}

// FromAccount tells libocr which transmitter identity we are using.
func (t logTransmitter) FromAccount(context.Context) (types.Account, error) { return t.from, nil }

// Transmit is called by libocr once the report is attested and this oracle is
// selected by the transmission schedule.
//
// IMPORTANT: `sigs` is not "all signatures from all nodes"; libocr provides only
// the minimum quorum needed for on-chain verification (typically f+1) to save bytes.
func (t logTransmitter) Transmit(ctx context.Context, configDigest types.ConfigDigest, seqNr uint64, reportWithInfo ocr3types.ReportWithInfo[struct{}], sigs []types.AttributedOnchainSignature) error {
	var out outcomePayload
	if err := json.Unmarshal(reportWithInfo.Report, &out); err != nil {
		return err
	}
	if strings.TrimSpace(out.StatementHash) == "" && strings.TrimSpace(out.Statement) != "" {
		out.StatementHash = statementHashHex(out.Statement)
	}
	publicOut := out
	publicOut.Trust = nil

	var vcBytes []byte
	if t.vcIssuerURL != "" && out.RequestID != "" {
		var err error
		vcBytes, err = t.buildVCViaCAVS(publicOut, sigs)
		if err != nil {
			fmt.Printf("vc build error requestId=%s err=%v\n", out.RequestID, err)
		} else if len(vcBytes) > 0 {
			publicOut.VC = json.RawMessage(vcBytes)
		}
	}

	fmt.Printf("TRANSMIT oracle=%d from=%s configDigest=%s seqNr=%d requestId=%s sigs=%d competent=%t conf=%.2f\n",
		t.oracleID, string(t.from), configDigest.Hex(), seqNr, out.RequestID, len(sigs), out.Competent, out.Confidence)

	switch t.requestSource {
	case "", requestSourceQueue:
		if t.queueURL != "" && out.RequestID != "" {
			client := t.http
			if client == nil {
				client = &http.Client{Timeout: 10 * time.Second}
			}
			if err := postResultToQueue(ctx, client, t.queueURL, publicOut); err != nil {
				fmt.Printf("queue post result error requestId=%s err=%v\n", out.RequestID, err)
			}
		}
	case requestSourceChain:
		if out.RequestID != "" {
			if err := t.relayResultToRequester(ctx, publicOut); err != nil {
				return err
			}
		}
	}
	return nil
}

func (t logTransmitter) relayResultToRequester(ctx context.Context, out outcomePayload) error {
	endpoint := strings.TrimSpace(out.RequesterEndpoint)
	if endpoint == "" {
		return fmt.Errorf("missing requesterEndpoint for requestId=%s", out.RequestID)
	}
	body, err := json.Marshal(out)
	if err != nil {
		return err
	}
	client := t.http
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("relay to requester endpoint %s: %w", endpoint, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("relay to requester endpoint %s failed with http %d: %s", endpoint, resp.StatusCode, strings.TrimSpace(string(bodyBytes)))
	}
	return nil
}

func (t logTransmitter) buildVCViaCAVS(out outcomePayload, sigs []types.AttributedOnchainSignature) ([]byte, error) {
	if t.vcIssuerURL == "" {
		return nil, nil
	}
	holderDid := strings.TrimSpace(out.HolderDID)
	if holderDid == "" {
		return nil, fmt.Errorf("missing holderDid for VC payload")
	}
	statementHash := strings.TrimSpace(out.StatementHash)
	if statementHash == "" {
		return nil, fmt.Errorf("missing statementHash for VC payload")
	}

	// Use the actual OCR signers (by oracleID) to issue the VC.
	signerIDs := make([]int, 0, len(sigs))
	seen := map[int]bool{}
	for _, s := range sigs {
		idx := int(s.Signer)
		if idx < 0 {
			continue
		}
		if seen[idx] {
			continue
		}
		seen[idx] = true
		signerIDs = append(signerIDs, idx)
	}
	if len(signerIDs) == 0 {
		return nil, fmt.Errorf("no OCR signers provided for VC")
	}
	sort.Ints(signerIDs)

	payload := map[string]any{
		"statementHash":   statementHash,
		"holderDid":       holderDid,
		"competent":       out.Competent,
		"confidence":      out.Confidence,
		"reason":          out.Reason,
		"signerOracleIDs": signerIDs,
	}

	var vcResp struct {
		VC any `json:"vc"`
	}
	if err := httpPostJSON(t.http, strings.TrimRight(t.vcIssuerURL, "/")+"/ocr/vc", payload, &vcResp); err != nil {
		return nil, err
	}
	if vcResp.VC == nil {
		return nil, fmt.Errorf("vc issuer response missing vc")
	}
	return json.Marshal(vcResp.VC)
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
	trustDeltaBps int,
	trustedBeliefMinBps int,
	trustedUncertaintyMaxBps int,
) (types.ContractConfig, evmutil.EVMOffchainConfigDigester, error) {
	_, oracles, err := deriveAllNodes(n, oracleSeeds, cavsURL, registry)
	if err != nil {
		return types.ContractConfig{}, evmutil.EVMOffchainConfigDigester{}, err
	}
	pluginCfgBytes, _ := json.Marshal(pluginConfig{
		TrustDeltaBps:            trustDeltaBps,
		TrustedBeliefMinBps:      trustedBeliefMinBps,
		TrustedUncertaintyMaxBps: trustedUncertaintyMaxBps,
	})

	ephemeralSk := sha256.Sum256([]byte(fmt.Sprintf("ephemeralSk|%d", configSeed)))
	var sharedSecret [16]byte
	sharedSecretHash := sha256.Sum256([]byte(fmt.Sprintf("sharedSecret|%d", configSeed)))
	copy(sharedSecret[:], sharedSecretHash[:16])

	// Use very large timeouts; external model/service cold starts can take minutes.
	deltaRound := 30 * time.Second
	deltaProgress := 20 * time.Minute
	deltaResend := 2 * time.Minute
	deltaInitial := 5 * time.Second

	maxDurObs := 15 * time.Minute
	maxDurQuery := 30 * time.Second
	maxDurSAT := 30 * time.Second
	maxDurST := 30 * time.Second

	// ContractSetConfigArgsDeterministic is a helper that produces:
	// - signer/transmitter lists
	// - onchainConfig bytes
	// - offchainConfig bytes
	// for the given oracle set and timing parameters.
	signers, transmitters, fOut, onchainCfg, offchainCfgVersion, offchainCfg, err := ocr3confighelper.ContractSetConfigArgsDeterministic(
		ephemeralSk,
		sharedSecret,
		deltaProgress,
		deltaResend,
		deltaInitial,
		deltaRound,
		5*time.Second,  // deltaGrace
		10*time.Second, // deltaCertifiedCommitRequest
		10*time.Second, // deltaStage
		5,              // rMax
		[]int{n},
		oracles,
		pluginCfgBytes,
		nil,
		maxDurQuery,
		maxDurObs,
		maxDurSAT,
		maxDurST,
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

func httpPostJSON(client *http.Client, url string, body any, out any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(b))
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
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("http %d: %s", resp.StatusCode, string(bodyBytes))
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
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
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err != nil {
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

func setupOracleIdentityViaCAVS(cavsURL string, oracleID int) (didRegistryEntry, error) {
	deadline := time.Now().Add(2 * time.Minute)
	for {
		var resp cavsSetupResponse
		err := httpPostJSON(nil, strings.TrimRight(cavsURL, "/")+"/setup", map[string]any{
			"oracleId": oracleID,
		}, &resp)
		if err == nil {
			if !resp.OK {
				err = fmt.Errorf("cavs setup oracle %d returned ok=false", oracleID)
			} else if strings.TrimSpace(resp.DID) == "" {
				err = fmt.Errorf("cavs setup oracle %d returned empty did", oracleID)
			} else if _, resolveErr := resolveDIDEthAddressViaCAVS(nil, cavsURL, resp.DID); resolveErr != nil {
				err = fmt.Errorf("cavs setup oracle %d returned did that cavs cannot resolve: %w", oracleID, resolveErr)
			} else {
				return didRegistryEntry{
					OracleID: oracleID,
					DID:      strings.TrimSpace(resp.DID),
				}, nil
			}
		}
		if time.Now().After(deadline) {
			return didRegistryEntry{}, fmt.Errorf("cavs setup oracle %d: %w", oracleID, err)
		}
		time.Sleep(2 * time.Second)
	}
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
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err != nil {
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
			addr, err := resolveDIDEthAddressViaCAVS(client, cavsURL, entry.DID)
			if err != nil {
				readErr = fmt.Errorf("oracle %d resolve eth address via cavs: %w", i, err)
				break
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
	didRegistryDir string,
	didRegistryWaitTimeout time.Duration,
	trustDeltaBps int,
	trustedBeliefMinBps int,
	trustedUncertaintyMaxBps int,
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

	cc, _, err := buildContractConfig(n, f, seed, oracleSeeds, cavsURL, registry, trustDeltaBps, trustedBeliefMinBps, trustedUncertaintyMaxBps)
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

	fmt.Printf("bootstrap peerId=%s listen=%s announce=%s registry=%s configDigest=%s\n", pid.String(), listenAddr, announceAddrResolved, didRegistryDir, cc.ConfigDigest.Hex())
	<-ctx.Done()
	return nil
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
	requestSource string,
	contractRPCURL string,
	contractAddress string,
	oraclePublicEndpoint string,
	bootstrapAddr string,
	p2pListen string,
	p2pAnnounce string,
	skillExtractorURL string,
	competenceMode string,
	didRegistryDir string,
	didRegistryWaitTimeout time.Duration,
	logObservations bool,
	postObservations bool,
	trustDeltaBps int,
	trustedBeliefMinBps int,
	trustedUncertaintyMaxBps int,
	vcIssuerURL string,
) error {
	if oracleID < 0 || oracleID >= n {
		return fmt.Errorf("oracle_id out of range: %d (n=%d)", oracleID, n)
	}
	if strings.TrimSpace(skillExtractorURL) == "" {
		return fmt.Errorf("skill_extractor_url is required in mode=oracle")
	}
	requestSource = strings.TrimSpace(requestSource)
	if requestSource == "" {
		requestSource = requestSourceQueue
	}
	if requestSource != requestSourceQueue && requestSource != requestSourceChain {
		return fmt.Errorf("unsupported request_source %q", requestSource)
	}
	if requestSource == requestSourceChain {
		if strings.TrimSpace(queueURL) == "" {
			return fmt.Errorf("queue_url is required when request_source=contract")
		}
		if strings.TrimSpace(contractRPCURL) == "" {
			return fmt.Errorf("contract_rpc_url is required when request_source=contract")
		}
		if strings.TrimSpace(contractAddress) == "" {
			return fmt.Errorf("contract_address is required when request_source=contract")
		}
		if strings.TrimSpace(oraclePublicEndpoint) == "" {
			return fmt.Errorf("oracle_public_endpoint is required when request_source=contract")
		}
	}

	registryEntry, err := setupOracleIdentityViaCAVS(skillExtractorURL, oracleID)
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

	if vcIssuerURL == "" {
		vcIssuerURL = skillExtractorURL
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
	if requestSource == requestSourceChain {
		chainClient, err = noncentralizedclient.New(ctx, noncentralizedclient.Config{
			RPCURL:          contractRPCURL,
			ContractAddress: contractAddress,
			CAVSURL:         skillExtractorURL,
			OracleID:        oracleID,
			DID:             registryEntry.DID,
			Endpoint:        strings.TrimSpace(oraclePublicEndpoint),
		})
		if err != nil {
			return fmt.Errorf("init on-chain client: %w", err)
		}
		defer func() { _ = chainClient.Close() }()
		if err := chainClient.RegisterOracle(ctx); err != nil {
			return fmt.Errorf("register oracle on chain: %w", err)
		}
		fmt.Printf("oracle=%d requestQueue=%s requestIngressPublic=%s\n", oracleID, strings.TrimSpace(queueURL), strings.TrimSpace(oraclePublicEndpoint))
	}

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

	fmt.Printf("oracle=%d peerId=%s did=%s ethAddress=%s registry=%s localConfig=%s p2pListen=%s p2pAnnounce=%s skillExtractor=%s competenceMode=%s vcIssuer=%s requestSource=%s queue=%s publicRequestEndpoint=%s contractRPC=%s contractAddress=%s bootstrap=%s configDigest=%s\n",
		oracleID, me.peerID, registryEntry.DID, fromAcct, didRegistryDir, localContractConfigPath, p2pListen, p2pAnnounceResolved, skillExtractorURL, strings.TrimSpace(competenceMode), vcIssuerURL, requestSource, queueURL, strings.TrimSpace(oraclePublicEndpoint), strings.TrimSpace(contractRPCURL), strings.TrimSpace(contractAddress), bootstrapAddrResolved, cc.ConfigDigest.Hex())

	pluginFactory := cavsPluginFactory{
		queueURL:           queueURL,
		requestSource:      requestSource,
		skillExtractorURL:  skillExtractorURL,
		competenceMode:     competenceMode,
		observationTimeout: 15 * time.Minute,
		logObservations:    logObservations,
		postObservations:   postObservations,
		trustDIDs:          registryDIDs(registry),
	}

	tx := logTransmitter{
		oracleID:      commontypes.OracleID(oracleID),
		from:          fromAcct,
		queueURL:      queueURL,
		requestSource: requestSource,
		http:          &http.Client{Timeout: 10 * time.Second},
		vcIssuerURL:   vcIssuerURL,
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
			ContractTransmitterTransmitTimeout: 30 * time.Second,
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

	<-ctx.Done()
	return nil
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

	var (
		mode string

		n              int
		f              int
		oracleID       int
		seed           int64
		oracleSeed     int64
		oracleSeedsCSV string

		queueURL             string
		requestSource        string
		contractRPCURL       string
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

		logObservations  bool
		postObservations bool

		trustDeltaBps            int
		trustedBeliefMinBps      int
		trustedUncertaintyMaxBps int
		didRegistryWaitTimeout   time.Duration
		vcIssuerURL              string
	)

	flag.StringVar(&mode, "mode", "oracle", "bootstrap|oracle")
	flag.IntVar(&n, "n", 4, "number of oracles")
	flag.IntVar(&f, "f", 1, "fault tolerance")
	flag.IntVar(&oracleID, "oracle_id", 0, "oracle id (0..n-1) for mode=oracle")
	flag.Int64Var(&seed, "seed", seedDefault, "shared deployment seed for bootstrap peer identity and OCR config randomness (must match bootstrap and all oracles; can also come from OCR_SEED)")
	flag.Int64Var(&oracleSeed, "oracle_seed", oracleSeedDefault, "per-oracle seed for offchain/config private keys (mode=oracle; can also come from OCR_ORACLE_SEED)")
	flag.StringVar(&oracleSeedsCSV, "oracle_seeds", oracleSeedsDefault, "comma-separated per-oracle seeds for OCR identities (mode=bootstrap; can also come from OCR_ORACLE_SEEDS)")

	flag.StringVar(&queueURL, "queue_url", "http://queue:20000", "queue base url (mode=oracle; shared queue in request_source=queue, per-oracle sidecar queue in request_source=contract)")
	flag.StringVar(&requestSource, "request_source", requestSourceQueue, "request backend for mode=oracle: queue|contract")
	flag.StringVar(&contractRPCURL, "contract_rpc_url", "", "RPC URL for the smart-contract backend (mode=oracle, request_source=contract)")
	flag.StringVar(&contractAddress, "contract_address", "", "smart contract address for the non-centralized backend (mode=oracle, request_source=contract)")
	flag.StringVar(&oraclePublicEndpoint, "oracle_public_endpoint", "", "public queue endpoint stored on-chain for this oracle (mode=oracle, request_source=contract)")

	flag.StringVar(&bootstrapListen, "bootstrap_listen", "0.0.0.0:19900", "bootstrap listen address (mode=bootstrap)")
	flag.StringVar(&bootstrapAnnounce, "bootstrap_announce", "bootstrap:19900", "bootstrap announce address (mode=bootstrap)")
	flag.StringVar(&bootstrapAddr, "bootstrap_addr", "bootstrap:19900", "bootstrap address for oracles to dial (mode=oracle)")
	flag.StringVar(&didRegistryDir, "did_registry_dir", "/registry", "shared directory that stores one DID registry file per oracle")

	flag.StringVar(&p2pListen, "p2p_listen", "0.0.0.0:20010", "oracle p2p listen address (mode=oracle)")
	flag.StringVar(&p2pAnnounce, "p2p_announce", "", "oracle p2p announce address (mode=oracle); default oracle{ID}:20010")

	flag.StringVar(&skillExtractorURL, "skill_extractor_url", "", "base url for CAVS extractor/competence endpoint and DID/address resolution (mode=oracle/bootstrap)")
	flag.StringVar(&competenceMode, "competence_mode", "", "optional competence mode forwarded to CAVS /extract (e.g. gpt); empty uses CAVS default")
	flag.BoolVar(&logObservations, "log_observations", true, "print each oracle's Observation() output (skills)")
	flag.BoolVar(&postObservations, "post_observations", true, "persist each oracle's observation to the active request backend (queue or contract)")
	flag.IntVar(&trustDeltaBps, "trust_delta_bps", 10, "positive evidence threshold distance to median on the 0..100 trust scale (uncertain up to 2x)")
	flag.IntVar(&trustedBeliefMinBps, "trusted_belief_min_bps", 51, "trusted-set criterion on the 0..100 trust scale: belief >= this value")
	flag.IntVar(&trustedUncertaintyMaxBps, "trusted_uncertainty_max_bps", 49, "trusted-set criterion on the 0..100 trust scale: uncertainty <= this value")
	flag.DurationVar(&didRegistryWaitTimeout, "did_registry_wait_timeout", 5*time.Minute, "maximum time to wait for all DID registry files before starting OCR")
	flag.StringVar(&vcIssuerURL, "vc_issuer_url", "", "base url for issuing VCs via CAVS service (optional; defaults to skill_extractor_url)")
	flag.Parse()

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
		must(runBootstrap(ctx, n, f, seed, oracleSeeds, bootstrapListen, bootstrapAnnounce, skillExtractorURL, didRegistryDir, didRegistryWaitTimeout, trustDeltaBps, trustedBeliefMinBps, trustedUncertaintyMaxBps))
	case "oracle":
		if !oracleSeedFromEnv && !flagWasSet("oracle_seed") {
			fmt.Fprintln(os.Stderr, "missing oracle seed: set -oracle_seed or OCR_ORACLE_SEED")
			os.Exit(2)
		}
		must(runOracle(ctx, oracleID, n, f, seed, oracleSeed, queueURL, requestSource, contractRPCURL, contractAddress, oraclePublicEndpoint, bootstrapAddr, p2pListen, p2pAnnounce, skillExtractorURL, competenceMode, didRegistryDir, didRegistryWaitTimeout, logObservations, postObservations, trustDeltaBps, trustedBeliefMinBps, trustedUncertaintyMaxBps, vcIssuerURL))
	default:
		must(fmt.Errorf("unknown mode: %q", mode))
	}
}
