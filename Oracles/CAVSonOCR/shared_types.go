package main

import (
	"encoding/json"
	"time"
)

// shared_types.go contains data structures used by both:
// - the queue node (HTTP API)
// - the oracle nodes (Query/Observation/Outcome/Transmit payloads)

// simSkill is the "unit" that gets observed and aggregated.
//
// ScoreBps is a score in basis points (0..10000).
type simSkill struct {
	URI      string `json:"uri"`
	Label    string `json:"label,omitempty"`
	ScoreBps uint16 `json:"scoreBps"` // 0..10000
}

// queryPayload is the "job" distributed by the queue:
// the oracles should extract skills from Statement and agree on an Outcome.
type queryPayload struct {
	RequestID         string          `json:"requestId,omitempty"`
	OracleSetID       string          `json:"oracleSetID,omitempty"`
	RequesterEndpoint string          `json:"requesterEndpoint,omitempty"`
	Statement         string          `json:"statement,omitempty"`
	StatementHash     string          `json:"statementHash,omitempty"`
	HolderDID         string          `json:"holderDid,omitempty"`
	SeedUnused        int64           `json:"seed,omitempty"`         // optional; reserved for future modes
	AuthorSkills      []string        `json:"authorSkills,omitempty"` // canonical "(label, uri)" strings
	Presentation      json.RawMessage `json:"presentation,omitempty"`

	// queueImportedAt/admissionNotBefore/admissionDelay are deliberately local
	// and are never serialized into OCR query bytes. They instrument and gate
	// the interval between successful per-oracle queue import and the leader's
	// admission of that real request into an OCR round.
	queueImportedAt    time.Time
	admissionNotBefore time.Time
	admissionDelay     time.Duration
}

// observationPayload is what an oracle sends as its Observation() output.
// In OCR3 this is opaque bytes to the protocol.
type observationPayload struct {
	RequestID     string `json:"requestId,omitempty"`
	OracleSetID   string `json:"oracleSetID,omitempty"`
	StatementHash string `json:"statementHash,omitempty"`
	// Available is nil/true for a successful external observation. An explicit
	// false is a signed availability envelope: it lets a leader whose own
	// backend failed continue coordinating the round, while quorum and Outcome
	// exclude that failed external observation.
	Available    *bool      `json:"available,omitempty"`
	Skills       []simSkill `json:"skills"`
	AuthorSkills []string   `json:"authorSkills,omitempty"`
	Competent    bool       `json:"competent"`
	Confidence   float64    `json:"confidence"`
	Reason       string     `json:"reason,omitempty"`
}

// outcomePayload is the agreed, deterministic aggregation of all observations.
// We reuse this JSON blob as the Report bytes as well (see Reports()).
//
// Fields prefixed `Attested*` are populated by the transmitter AFTER libocr
// finishes report attestation; they are NOT part of the deterministic bytes
// produced by Outcome()/Reports() (each is `omitempty` so a zero/empty value
// disappears from the JSON, leaving the consensus-signed blob untouched), and
// they MUST NOT be set inside any reporting-plugin method.
type outcomePayload struct {
	RequestID         string          `json:"requestId,omitempty"`
	OracleSetID       string          `json:"oracleSetID,omitempty"`
	RequesterEndpoint string          `json:"requesterEndpoint,omitempty"`
	Statement         string          `json:"statement,omitempty"`
	StatementHash     string          `json:"statementHash,omitempty"`
	HolderDID         string          `json:"holderDid,omitempty"`
	Skills            []simSkill      `json:"skills"`
	Trust             *trustPayload   `json:"trust,omitempty"`
	VC                json.RawMessage `json:"vc,omitempty"`
	Competent         bool            `json:"competent"`
	Confidence        float64         `json:"confidence"`
	Reason            string          `json:"reason,omitempty"`

	// Off-chain attestation envelope. Lets the requester pick any subset of the
	// listed oracle IDs (of size >= AttestedThreshold) when triggering the
	// downstream BLS multi-issuer VC flow, instead of being pinned to a brittle
	// F+1 set.
	AttestedSignerOracleIDs []uint8 `json:"attestedSignerOracleIds,omitempty"`
	AttestedThreshold       uint8   `json:"attestedThreshold,omitempty"`
	AttestedSeqNr           uint64  `json:"attestedSeqNr,omitempty"`
	AttestedConfigDigest    string  `json:"attestedConfigDigest,omitempty"`
}

// trustOpinionBps encodes a subjective-logic opinion (b,d,u) on the trust
// scale used by this project.
//
// Historical name aside, each component is 0..100 and b+d+u=100.
type trustOpinionBps struct {
	B uint16 `json:"b"`
	D uint16 `json:"d"`
	U uint16 `json:"u"`
}

type trustEvidenceCounts struct {
	Pos uint32 `json:"pos"`
	Neg uint32 `json:"neg"`
	Unc uint32 `json:"unc"`
}

// trustPayload is a global trust model replicated across all peers by embedding
// it in the OCR3 outcome and reading it from OutcomeContext.PreviousOutcome.
type trustPayload struct {
	// DIDs records which oracle DID each Running/Pending slot belongs to, so
	// trust can be remapped if the oracle set changes order or membership.
	DIDs []string `json:"dids,omitempty"`
	// EpochLen is the number of evaluated requests per trust epoch.
	EpochLen uint32 `json:"epochLen"`
	// Epoch is 1-based and increments after each completed trust epoch.
	Epoch uint64 `json:"epoch"`

	Running []trustOpinionBps     `json:"running"`
	Pending []trustEvidenceCounts `json:"pending,omitempty"`
	// RequestsInEpoch counts how many evaluated requests have been accumulated in Pending.
	RequestsInEpoch uint32 `json:"requestsInEpoch,omitempty"`

	// Trusted is derived from (b,u) thresholds and used in the next epoch.
	Trusted []bool `json:"trusted,omitempty"`
}

// storedObservation is how we persist per-oracle observations in the queue, so
// we can later query "what did each oracle see?" for a given requestId.
type storedObservation struct {
	OracleID     int        `json:"oracleId"`
	SeqNr        uint64     `json:"seqNr"`
	Skills       []simSkill `json:"skills"`
	AuthorSkills []string   `json:"authorSkills,omitempty"`
	Competent    bool       `json:"competent"`
	Confidence   float64    `json:"confidence"`
	Reason       string     `json:"reason,omitempty"`
}
