//go:build !queue

package main

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smartcontractkit/libocr/commontypes"
	"github.com/smartcontractkit/libocr/offchainreporting2plus/ocr3types"
	"github.com/smartcontractkit/libocr/offchainreporting2plus/types"
)

func newTestPlugin() *cavsPlugin {
	pc := pluginConfig{
		TrustDeltaBps:            10,
		TrustedBeliefMinBps:      51,
		TrustedUncertaintyMaxBps: 49,
	}
	pc.normalize()
	return &cavsPlugin{
		cfg:       ocr3types.ReportingPluginConfig{N: 4},
		pc:        pc,
		trustDIDs: []string{"did:oracle:0", "did:oracle:1", "did:oracle:2", "did:oracle:3"},
	}
}

func mustMarshalQuery(t *testing.T, requestID string) types.Query {
	t.Helper()
	b, err := json.Marshal(queryPayload{
		RequestID: requestID,
		Statement: "statement",
		HolderDID: "did:ethr:0x123",
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
		Participating: true,
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
	if math.Abs(got.Confidence-0.2) > 1e-9 {
		t.Fatalf("expected zero-weight oracle to be excluded from median, got confidence=%v", got.Confidence)
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
	if math.Abs(got.Confidence-0.2) > 1e-9 {
		t.Fatalf("expected confidence to use only competence-aligned observations, got %v", got.Confidence)
	}
	if got.Reason != "aligned-low" {
		t.Fatalf("expected reason from closest competence-aligned oracle, got %q", got.Reason)
	}
}

func TestOutcomeTrustUpdatesEveryRequest(t *testing.T) {
	p := newTestPlugin()
	obs := []types.AttributedObservation{
		mustMarshalObservation(t, 0, true, 0.9),
		mustMarshalObservation(t, 1, true, 0.9),
		mustMarshalObservation(t, 2, true, 0.9),
	}

	out, err := p.Outcome(context.Background(), ocr3types.OutcomeContext{SeqNr: 1}, mustMarshalQuery(t, "req-1"), obs)
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

func TestOutcomeSkipsNonParticipatingObservations(t *testing.T) {
	p := newTestPlugin()
	query := mustMarshalQuery(t, "req-targeted")

	skippedBytes, err := json.Marshal(observationPayload{
		Participating: false,
		Competent:     true,
		Confidence:    1.0,
		Reason:        "should be ignored",
	})
	if err != nil {
		t.Fatalf("marshal skipped observation: %v", err)
	}
	obs := []types.AttributedObservation{
		{
			Observer:    0,
			Observation: types.Observation(skippedBytes),
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
	if math.Abs(got.Confidence-0.3) > 1e-9 {
		t.Fatalf("expected skipped observation to be ignored, got confidence=%v", got.Confidence)
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

func TestObservationContractModeDefaultsToDidNotShare(t *testing.T) {
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
	if !got.Participating {
		t.Fatalf("expected did-not-share observation to remain participating")
	}
	if got.Competent {
		t.Fatalf("expected competent=false when request was not shared")
	}
	if got.Confidence != 1.0 {
		t.Fatalf("expected confidence=1.0, got %v", got.Confidence)
	}
	if got.Reason != "did not share" {
		t.Fatalf("expected reason=did not share, got %q", got.Reason)
	}
	if storedCount != 1 {
		t.Fatalf("expected one stored observation post, got %d", storedCount)
	}
	if stored.Reason != "did not share" {
		t.Fatalf("expected stored local observation for did-not-share, got %+v", stored)
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
