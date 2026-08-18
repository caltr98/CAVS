package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

var errQueueFull = errors.New("request queue capacity reached")

// requestQueue tracks local request state for both the standalone queue binary
// and the in-process contract request path inside each oracle.
type requestQueue struct {
	mu      sync.Mutex
	items   map[string]queryPayload
	pending []queryPayload
	active  *queryPayload
	// claimed records requests that this oracle has already seen selected in
	// an OCR Query. Claimed requests remain eligible for a later OCR round until
	// an attested report marks them complete. This is essential when an
	// observation deadline expires before quorum: the current or a replacement
	// leader must be able to retry the request instead of orphaning it.
	claimed   map[string]bool
	completed map[string]bool
	result    map[string]outcomePayload
	obs       map[string]map[int]storedObservation // requestId -> oracleId -> observation
	// waiters is keyed by request ID so Observation can wait for its own local
	// contract-event import without polling or delaying unrelated requests.
	waiters    map[string]map[chan struct{}]struct{}
	maxItems   int
	maxPending int
	// completedOrder bounds historical state without ever evicting pending or
	// active work. Old completed results remain queryable up to maxCompleted;
	// after that they are removed FIFO.
	completedOrder []string
	maxCompleted   int

	mux *http.ServeMux
	srv *http.Server
}

func newRequestQueue() *requestQueue {
	maxItems := envInt("OCR_QUEUE_MAX_ITEMS", 10000)
	return &requestQueue{
		items:      map[string]queryPayload{},
		claimed:    map[string]bool{},
		completed:  map[string]bool{},
		result:     map[string]outcomePayload{},
		obs:        map[string]map[int]storedObservation{},
		waiters:    map[string]map[chan struct{}]struct{}{},
		maxItems:   maxItems,
		maxPending: envInt("OCR_QUEUE_MAX_PENDING", 1000),
		// Retain a useful result/debug window by default, while admission can
		// evict even within this window if completed history is the only reason
		// maxItems would reject new live work.
		maxCompleted: envInt("OCR_QUEUE_MAX_COMPLETED_ITEMS", min(1000, maxItems)),
	}
}

func cloneRawJSON(raw []byte) []byte {
	if len(raw) == 0 {
		return nil
	}
	out := make([]byte, len(raw))
	copy(out, raw)
	return out
}

func cloneSkills(in []simSkill) []simSkill {
	if len(in) == 0 {
		return nil
	}
	out := make([]simSkill, len(in))
	copy(out, in)
	return out
}

func cloneStrings(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	out := make([]string, len(in))
	copy(out, in)
	return out
}

func cloneTrustPayload(in *trustPayload) *trustPayload {
	if in == nil {
		return nil
	}
	out := &trustPayload{
		DIDs:            cloneStrings(in.DIDs),
		EpochLen:        in.EpochLen,
		Epoch:           in.Epoch,
		RequestsInEpoch: in.RequestsInEpoch,
		Trusted:         append([]bool(nil), in.Trusted...),
	}
	if len(in.Running) > 0 {
		out.Running = make([]trustOpinionBps, len(in.Running))
		copy(out.Running, in.Running)
	}
	if len(in.Pending) > 0 {
		out.Pending = make([]trustEvidenceCounts, len(in.Pending))
		copy(out.Pending, in.Pending)
	}
	return out
}

func cloneQueryPayload(in queryPayload) queryPayload {
	in.AuthorSkills = cloneStrings(in.AuthorSkills)
	in.Presentation = cloneRawJSON(in.Presentation)
	return in
}

func cloneStoredObservation(in storedObservation) storedObservation {
	in.Skills = cloneSkills(in.Skills)
	in.AuthorSkills = cloneStrings(in.AuthorSkills)
	return in
}

func cloneOutcomePayload(in outcomePayload) outcomePayload {
	in.Skills = cloneSkills(in.Skills)
	in.Trust = cloneTrustPayload(in.Trust)
	in.VC = cloneRawJSON(in.VC)
	return in
}

func (q *requestQueue) isPendingLocked(id string) bool {
	for _, p := range q.pending {
		if p.RequestID == id {
			return true
		}
	}
	return false
}

func (q *requestQueue) statusLocked(id string) string {
	if _, ok := q.result[id]; ok || q.completed[id] {
		return "done"
	}
	if q.active != nil && q.active.RequestID == id {
		return "active"
	}
	if q.isPendingLocked(id) {
		return "pending"
	}
	if q.claimed[id] {
		return "active"
	}
	return "unknown"
}

func (q *requestQueue) removePendingLocked(id string) {
	if len(q.pending) == 0 {
		return
	}
	filtered := q.pending[:0]
	for _, item := range q.pending {
		if item.RequestID == id {
			continue
		}
		filtered = append(filtered, item)
	}
	q.pending = filtered
}

func (q *requestQueue) notifyRequestWaitersLocked(requestID string) {
	for waiter := range q.waiters[requestID] {
		close(waiter)
	}
	delete(q.waiters, requestID)
}

func (q *requestQueue) evictCompletedLocked(requestID string) bool {
	if requestID == "" || !q.completed[requestID] {
		return false
	}
	// Defensive invariant checks: completed history must never evict work that
	// somehow became live again.
	if q.active != nil && q.active.RequestID == requestID {
		return false
	}
	if q.isPendingLocked(requestID) {
		return false
	}
	delete(q.items, requestID)
	delete(q.completed, requestID)
	delete(q.claimed, requestID)
	delete(q.result, requestID)
	delete(q.obs, requestID)
	q.notifyRequestWaitersLocked(requestID)
	return true
}

func (q *requestQueue) evictOldestCompletedLocked() bool {
	for len(q.completedOrder) > 0 {
		requestID := q.completedOrder[0]
		q.completedOrder = q.completedOrder[1:]
		if q.evictCompletedLocked(requestID) {
			return true
		}
	}
	return false
}

func (q *requestQueue) trimCompletedHistoryLocked() {
	for len(q.completedOrder) > q.maxCompleted {
		if !q.evictOldestCompletedLocked() {
			return
		}
	}
}

func (q *requestQueue) ensureItemCapacityLocked() bool {
	for len(q.items) >= q.maxItems {
		if !q.evictOldestCompletedLocked() {
			return false
		}
	}
	return true
}

func (q *requestQueue) markCompletedLocked(requestID string) {
	if requestID == "" || q.completed[requestID] {
		return
	}
	q.completed[requestID] = true
	q.completedOrder = append(q.completedOrder, requestID)
	q.trimCompletedHistoryLocked()
}

func (q *requestQueue) recordObservation(requestID string, oracleID int, seqNr uint64, obs storedObservation) {
	if requestID == "" {
		return
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.obs[requestID] == nil {
		q.obs[requestID] = map[int]storedObservation{}
	}
	copied := cloneStoredObservation(obs)
	copied.OracleID = oracleID
	copied.SeqNr = seqNr
	q.obs[requestID][oracleID] = copied
}

func (q *requestQueue) importRequest(item queryPayload) (string, string, error) {
	item = cloneQueryPayload(item)
	item.RequestID = strings.TrimSpace(item.RequestID)
	item.Statement = strings.TrimSpace(item.Statement)
	item.StatementHash = strings.TrimSpace(item.StatementHash)
	item.HolderDID = strings.TrimSpace(item.HolderDID)
	item.OracleSetID = strings.TrimSpace(item.OracleSetID)
	item.RequesterEndpoint = strings.TrimSpace(item.RequesterEndpoint)
	item.Presentation = compactRawJSON(item.Presentation)
	if item.RequestID == "" {
		return "", "", fmt.Errorf("missing requestId")
	}
	if item.Statement == "" && item.StatementHash == "" {
		return "", "", fmt.Errorf("missing statement or statementHash")
	}
	if item.HolderDID == "" {
		return "", "", fmt.Errorf("missing holderDid")
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	status := q.statusLocked(item.RequestID)
	if _, exists := q.items[item.RequestID]; !exists {
		claimed := q.claimed[item.RequestID]
		completed := q.completed[item.RequestID]
		if (!claimed && len(q.pending) >= q.maxPending) || !q.ensureItemCapacityLocked() {
			return "", "", errQueueFull
		}
		item.queueImportedAt = time.Now()
		item.admissionDelay = queueRoundAdmissionDelayFromEnv()
		if item.admissionDelay > 0 {
			item.admissionNotBefore = item.queueImportedAt.Add(item.admissionDelay)
			fmt.Printf("[PHASE-SLEEP] phase=%s configured=%s requestId=%s gate=queue-availability\n",
				phaseRoundAdmission, item.admissionDelay, item.RequestID)
		}
		q.items[item.RequestID] = item
		q.notifyRequestWaitersLocked(item.RequestID)
		if completed {
			status = "done"
		} else if claimed {
			// Query arrived before this oracle imported the contract event.
			// Retain the request as retryable work until an attested report
			// completes it. Admission timing belongs only to the first leader
			// selection, which already happened on another oracle.
			item.queueImportedAt = time.Time{}
			item.admissionDelay = 0
			item.admissionNotBefore = time.Time{}
			q.pending = append(q.pending, item)
			status = "active"
		} else {
			q.pending = append(q.pending, item)
			status = "pending"
		}
	}
	return item.RequestID, status, nil
}

func (q *requestQueue) submitDirectRequest(item queryPayload) (string, string, error) {
	item = cloneQueryPayload(item)
	item.RequesterEndpoint = strings.TrimSpace(item.RequesterEndpoint)
	item.OracleSetID = strings.TrimSpace(item.OracleSetID)
	item.Statement = strings.TrimSpace(item.Statement)
	item.StatementHash = strings.TrimSpace(item.StatementHash)
	item.HolderDID = strings.TrimSpace(item.HolderDID)
	item.Presentation = compactRawJSON(item.Presentation)
	if item.RequesterEndpoint == "" {
		return "", "", fmt.Errorf("missing requesterEndpoint")
	}
	if item.Statement == "" {
		return "", "", fmt.Errorf("missing statement")
	}
	if item.HolderDID == "" {
		return "", "", fmt.Errorf("missing holderDid")
	}

	q.mu.Lock()
	defer q.mu.Unlock()

	status := "pending"
	if len(item.Presentation) > 0 {
		item.RequestID = hashDirectRequestWithPresentation(item.RequesterEndpoint, item.Statement, item.HolderDID, item.Presentation)
	} else {
		item.RequestID = hashDirectRequest(item.RequesterEndpoint, item.Statement, item.HolderDID, item.AuthorSkills)
	}
	status = q.statusLocked(item.RequestID)
	if status == "unknown" {
		if len(q.pending) >= q.maxPending || !q.ensureItemCapacityLocked() {
			return "", "", errQueueFull
		}
		q.pending = append(q.pending, item)
		q.items[item.RequestID] = item
		status = "pending"
	}
	return item.RequestID, status, nil
}

func (q *requestQueue) currentRequest() (queryPayload, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.active != nil {
		// A prior OCR round selected this request but did not produce an
		// attested report. Replay it in the next round; completeRequest clears
		// active on every oracle after successful attestation.
		return cloneQueryPayload(*q.active), true
	}
	if len(q.pending) == 0 {
		return queryPayload{}, false
	}
	if !q.pending[0].admissionNotBefore.IsZero() && time.Now().Before(q.pending[0].admissionNotBefore) {
		return queryPayload{}, false
	}
	item := cloneQueryPayload(q.pending[0])
	q.pending = q.pending[1:]
	q.active = &item
	fmt.Printf("queue activated requestId=%s\n", item.RequestID)
	selected := cloneQueryPayload(*q.active)
	// ROUND_ADMISSION is measured once, on initial selection. A retry should
	// measure the new QUERY/OBSERVATION work without charging the original
	// queue wait again.
	q.active.queueImportedAt = time.Time{}
	q.active.admissionDelay = 0
	q.active.admissionNotBefore = time.Time{}
	return selected, true
}

// claimRequest marks a request as already selected by the OCR protocol.
// Followers keep their pending copy so a replacement leader can retry the
// request if the selected round fails to reach observation quorum. Successful
// attestation removes it through completeRequest on every oracle.
//
// The claim is retained even when import has not happened yet. importRequest
// consults the tombstone and stores a late payload as retryable work.
func (q *requestQueue) claimRequest(requestID string) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	q.claimed[requestID] = true
	for i := range q.pending {
		if q.pending[i].RequestID != requestID {
			continue
		}
		// The first selection happened on the broadcasting leader. If this
		// follower later retries it, do not record a second ROUND_ADMISSION.
		q.pending[i].queueImportedAt = time.Time{}
		q.pending[i].admissionDelay = 0
		q.pending[i].admissionNotBefore = time.Time{}
	}
}

func (q *requestQueue) storedRequest(requestID string) (queryPayload, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	item, ok := q.items[requestID]
	if !ok {
		return queryPayload{}, false
	}
	return cloneQueryPayload(item), true
}

// waitForStoredRequest returns immediately when the request was already
// imported. Otherwise it registers a request-specific notification and waits
// until import, completion, or context cancellation. Registering the waiter and
// checking items happen under the same mutex as importRequest, so no wakeup can
// be lost between those operations.
func (q *requestQueue) waitForStoredRequest(ctx context.Context, requestID string) (queryPayload, bool, error) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return queryPayload{}, false, nil
	}

	q.mu.Lock()
	if item, ok := q.items[requestID]; ok {
		q.mu.Unlock()
		return cloneQueryPayload(item), true, nil
	}
	if q.completed[requestID] {
		q.mu.Unlock()
		return queryPayload{}, false, nil
	}
	waiter := make(chan struct{})
	if q.waiters[requestID] == nil {
		q.waiters[requestID] = map[chan struct{}]struct{}{}
	}
	q.waiters[requestID][waiter] = struct{}{}
	q.mu.Unlock()

	select {
	case <-waiter:
	case <-ctx.Done():
		q.mu.Lock()
		if requestWaiters := q.waiters[requestID]; requestWaiters != nil {
			delete(requestWaiters, waiter)
			if len(requestWaiters) == 0 {
				delete(q.waiters, requestID)
			}
		}
		q.mu.Unlock()
		return queryPayload{}, false, ctx.Err()
	}

	q.mu.Lock()
	defer q.mu.Unlock()
	item, ok := q.items[requestID]
	if !ok {
		return queryPayload{}, false, nil
	}
	return cloneQueryPayload(item), true, nil
}

func (q *requestQueue) observations(requestID string) []storedObservation {
	q.mu.Lock()
	defer q.mu.Unlock()
	m := q.obs[requestID]
	out := make([]storedObservation, 0, len(m))
	for _, v := range m {
		out = append(out, cloneStoredObservation(v))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].OracleID < out[j].OracleID })
	return out
}

func (q *requestQueue) storeResult(requestID string, out outcomePayload) {
	if requestID == "" {
		return
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if _, exists := q.result[requestID]; !exists {
		copied := cloneOutcomePayload(out)
		if copied.RequestID == "" {
			copied.RequestID = requestID
		}
		q.result[requestID] = copied
	}
	if q.active != nil && q.active.RequestID == requestID {
		q.active = nil
	}
	q.claimed[requestID] = true
	q.removePendingLocked(requestID)
	q.markCompletedLocked(requestID)
	q.notifyRequestWaitersLocked(requestID)
}

func (q *requestQueue) completeRequest(requestID string) {
	if requestID == "" {
		return
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.active != nil && q.active.RequestID == requestID {
		q.active = nil
	}
	q.claimed[requestID] = true
	q.removePendingLocked(requestID)
	q.markCompletedLocked(requestID)
	q.notifyRequestWaitersLocked(requestID)
}
