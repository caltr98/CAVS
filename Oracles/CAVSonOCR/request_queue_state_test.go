package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestRequestQueueRoundAdmissionGateDelaysAvailabilityOnce(t *testing.T) {
	t.Setenv("OCR_PHASE_SLEEP_ROUND_ADMISSION", "40ms")

	q := newRequestQueue()
	request := queryPayload{
		RequestID: "gated-request",
		Statement: "statement",
		HolderDID: "did:example:gated",
	}
	if _, status, err := q.importRequest(request); err != nil || status != "pending" {
		t.Fatalf("import gated request status=%q err=%v", status, err)
	}
	if got, ok := q.currentRequest(); ok {
		t.Fatalf("request activated before admission gate elapsed: %q", got.RequestID)
	}

	deadline := time.Now().Add(time.Second)
	for {
		got, ok := q.currentRequest()
		if ok {
			if got.RequestID != request.RequestID {
				t.Fatalf("activated request=%q, want %q", got.RequestID, request.RequestID)
			}
			if got.queueImportedAt.IsZero() || got.admissionDelay != 40*time.Millisecond {
				t.Fatalf("missing admission instrumentation: imported=%s delay=%s", got.queueImportedAt, got.admissionDelay)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("round-admission gate did not release request")
		}
		time.Sleep(5 * time.Millisecond)
	}
	retry, ok := q.currentRequest()
	if !ok || retry.RequestID != request.RequestID {
		t.Fatalf("active gated request was not retryable; got ok=%v request=%q", ok, retry.RequestID)
	}
	if !retry.queueImportedAt.IsZero() || retry.admissionDelay != 0 {
		t.Fatalf("retry repeated admission instrumentation: imported=%s delay=%s", retry.queueImportedAt, retry.admissionDelay)
	}
}

func TestRequestQueueAppliesPendingCapacity(t *testing.T) {
	q := newRequestQueue()
	q.maxPending = 1
	q.maxItems = 10
	request := func(id string) queryPayload {
		return queryPayload{RequestID: id, Statement: "statement", HolderDID: "did:example:test"}
	}
	if _, _, err := q.importRequest(request("one")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := q.importRequest(request("two")); !errors.Is(err, errQueueFull) {
		t.Fatalf("second import error=%v, want errQueueFull", err)
	}
}

func TestRequestQueueEvictsOnlyCompletedHistoryForAdmission(t *testing.T) {
	q := newRequestQueue()
	q.maxItems = 2
	q.maxPending = 2
	q.maxCompleted = 2
	request := func(id string) queryPayload {
		return queryPayload{RequestID: id, Statement: "statement", HolderDID: "did:example:" + id}
	}

	if _, _, err := q.importRequest(request("completed")); err != nil {
		t.Fatal(err)
	}
	if got, ok := q.currentRequest(); !ok || got.RequestID != "completed" {
		t.Fatalf("activate completed candidate got ok=%v request=%q", ok, got.RequestID)
	}
	q.recordObservation("completed", 0, 1, storedObservation{Reason: "debug history"})
	q.storeResult("completed", outcomePayload{RequestID: "completed", Reason: "retained result"})

	if _, _, err := q.importRequest(request("pending")); err != nil {
		t.Fatal(err)
	}
	// items is now at capacity: one completed history entry plus one live
	// pending request. A new request must evict only the completed entry.
	if _, status, err := q.importRequest(request("new")); err != nil || status != "pending" {
		t.Fatalf("new import status=%q err=%v", status, err)
	}

	if status := q.statusLocked("completed"); status != "unknown" {
		t.Fatalf("evicted completed status=%q, want unknown", status)
	}
	if _, ok := q.result["completed"]; ok {
		t.Fatal("evicted completed result was retained")
	}
	if _, ok := q.obs["completed"]; ok {
		t.Fatal("evicted completed observations were retained")
	}
	if _, ok := q.items["pending"]; !ok {
		t.Fatal("pending request was evicted")
	}
	if _, ok := q.items["new"]; !ok {
		t.Fatal("new pending request is missing")
	}
}

func TestRequestQueueTrimsCompletedHistoryFIFO(t *testing.T) {
	q := newRequestQueue()
	q.maxItems = 10
	q.maxPending = 10
	q.maxCompleted = 2
	request := func(id string) queryPayload {
		return queryPayload{RequestID: id, Statement: "statement", HolderDID: "did:example:" + id}
	}

	for _, id := range []string{"one", "two", "three"} {
		if _, _, err := q.importRequest(request(id)); err != nil {
			t.Fatalf("import %s: %v", id, err)
		}
		got, ok := q.currentRequest()
		if !ok || got.RequestID != id {
			t.Fatalf("activate %s got ok=%v request=%q", id, ok, got.RequestID)
		}
		q.completeRequest(id)
	}

	if status := q.statusLocked("one"); status != "unknown" {
		t.Fatalf("oldest completed status=%q, want unknown", status)
	}
	if q.claimed["one"] {
		t.Fatal("oldest completed claim tombstone was not evicted")
	}
	if status := q.statusLocked("two"); status != "done" {
		t.Fatalf("second completed status=%q, want done", status)
	}
	if status := q.statusLocked("three"); status != "done" {
		t.Fatalf("latest completed status=%q, want done", status)
	}
	if len(q.completedOrder) != 2 {
		t.Fatalf("completed history len=%d, want 2", len(q.completedOrder))
	}
}

func TestCurrentRequestReplaysActiveRequestUntilCompletion(t *testing.T) {
	q := newRequestQueue()
	first := queryPayload{
		RequestID:         "request-1",
		Statement:         "first statement",
		HolderDID:         "did:example:first",
		RequesterEndpoint: "http://requester/first",
	}
	second := queryPayload{
		RequestID:         "request-2",
		Statement:         "second statement",
		HolderDID:         "did:example:second",
		RequesterEndpoint: "http://requester/second",
	}

	if _, status, err := q.importRequest(first); err != nil || status != "pending" {
		t.Fatalf("import first status=%q err=%v", status, err)
	}
	if _, status, err := q.importRequest(second); err != nil || status != "pending" {
		t.Fatalf("import second status=%q err=%v", status, err)
	}

	got, ok := q.currentRequest()
	if !ok || got.RequestID != first.RequestID {
		t.Fatalf("first currentRequest got ok=%v request=%q", ok, got.RequestID)
	}

	got, ok = q.currentRequest()
	if !ok || got.RequestID != first.RequestID {
		t.Fatalf("active request was not replayed; got ok=%v request=%q", ok, got.RequestID)
	}
	if !got.queueImportedAt.IsZero() {
		t.Fatal("replayed request retained its initial admission timestamp")
	}

	q.completeRequest(first.RequestID)
	got, ok = q.currentRequest()
	if !ok || got.RequestID != second.RequestID {
		t.Fatalf("second currentRequest got ok=%v request=%q", ok, got.RequestID)
	}
}

func TestDuplicateActiveRequestIsDiscarded(t *testing.T) {
	q := newRequestQueue()
	first := queryPayload{
		RequestID:         "request-1",
		Statement:         "first statement",
		HolderDID:         "did:example:first",
		RequesterEndpoint: "http://requester/first",
	}
	second := queryPayload{
		RequestID:         "request-2",
		Statement:         "second statement",
		HolderDID:         "did:example:second",
		RequesterEndpoint: "http://requester/second",
	}

	if _, status, err := q.importRequest(first); err != nil || status != "pending" {
		t.Fatalf("import first status=%q err=%v", status, err)
	}
	if got, ok := q.currentRequest(); !ok || got.RequestID != first.RequestID {
		t.Fatalf("activate first got ok=%v request=%q", ok, got.RequestID)
	}

	if _, status, err := q.importRequest(first); err != nil || status != "active" {
		t.Fatalf("duplicate active import status=%q err=%v", status, err)
	}
	if _, status, err := q.importRequest(second); err != nil || status != "pending" {
		t.Fatalf("import second status=%q err=%v", status, err)
	}

	q.completeRequest(first.RequestID)
	if _, status, err := q.importRequest(first); err != nil || status != "done" {
		t.Fatalf("duplicate completed import status=%q err=%v", status, err)
	}

	got, ok := q.currentRequest()
	if !ok || got.RequestID != second.RequestID {
		t.Fatalf("duplicate active request was requeued; got ok=%v request=%q", ok, got.RequestID)
	}
	q.completeRequest(second.RequestID)
	if got, ok := q.currentRequest(); ok {
		t.Fatalf("unexpected extra queued request %q", got.RequestID)
	}
}

func TestClaimRequestRemovesPendingButPreservesLookup(t *testing.T) {
	q := newRequestQueue()
	first := queryPayload{
		RequestID:    "request-selected-by-other-leader",
		Statement:    "first statement",
		HolderDID:    "did:example:first",
		Presentation: []byte(`{"holder":"did:example:first"}`),
	}
	second := queryPayload{
		RequestID: "request-still-pending",
		Statement: "second statement",
		HolderDID: "did:example:second",
	}

	if _, _, err := q.importRequest(first); err != nil {
		t.Fatal(err)
	}
	if _, _, err := q.importRequest(second); err != nil {
		t.Fatal(err)
	}

	q.claimRequest(first.RequestID)
	q.claimRequest(first.RequestID) // Claims are idempotent.

	stored, ok := q.storedRequest(first.RequestID)
	if !ok {
		t.Fatal("claimed request payload was removed from lookup storage")
	}
	if stored.Statement != first.Statement || string(stored.Presentation) != string(first.Presentation) {
		t.Fatalf("claimed request payload changed: %+v", stored)
	}

	got, ok := q.currentRequest()
	if !ok || got.RequestID != first.RequestID {
		t.Fatalf("claimed request was not retained for retry; got ok=%v request=%q", ok, got.RequestID)
	}
	q.completeRequest(first.RequestID)
	got, ok = q.currentRequest()
	if !ok || got.RequestID != second.RequestID {
		t.Fatalf("next pending request got ok=%v request=%q", ok, got.RequestID)
	}
}

func TestClaimBeforeImportSuppressesLateEnqueue(t *testing.T) {
	q := newRequestQueue()
	request := queryPayload{
		RequestID: "query-before-import",
		Statement: "statement",
		HolderDID: "did:example:late",
	}

	q.claimRequest(request.RequestID)
	if _, status, err := q.importRequest(request); err != nil || status != "active" {
		t.Fatalf("late import status=%q err=%v, want active", status, err)
	}
	if _, ok := q.storedRequest(request.RequestID); !ok {
		t.Fatal("late imported payload was not retained for Observation lookup")
	}
	if got, ok := q.currentRequest(); !ok || got.RequestID != request.RequestID {
		t.Fatalf("late imported claimed request was not retryable; got ok=%v request=%q", ok, got.RequestID)
	}
}

func TestConcurrentClaimAndImportNeverLeavesRequestPending(t *testing.T) {
	q := newRequestQueue()
	q.maxItems = 1000
	q.maxPending = 1000

	for i := 0; i < 500; i++ {
		request := queryPayload{
			RequestID: fmt.Sprintf("concurrent-%d", i),
			Statement: "statement",
			HolderDID: fmt.Sprintf("did:example:%d", i),
		}
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			if _, _, err := q.importRequest(request); err != nil {
				t.Errorf("import %s: %v", request.RequestID, err)
			}
		}()
		go func() {
			defer wg.Done()
			<-start
			q.claimRequest(request.RequestID)
		}()
		close(start)
		wg.Wait()

		if _, ok := q.storedRequest(request.RequestID); !ok {
			t.Fatalf("iteration %d lost imported request", i)
		}
	}

	seen := map[string]bool{}
	for len(seen) < 500 {
		got, ok := q.currentRequest()
		if !ok {
			t.Fatalf("only %d/500 claimed requests remained retryable", len(seen))
		}
		if seen[got.RequestID] {
			t.Fatalf("request %q replayed after completion", got.RequestID)
		}
		seen[got.RequestID] = true
		q.completeRequest(got.RequestID)
	}
}

func TestClaimDoesNotReplaceLeaderActiveRequest(t *testing.T) {
	q := newRequestQueue()
	active := queryPayload{
		RequestID: "leader-active",
		Statement: "active statement",
		HolderDID: "did:example:active",
	}
	other := queryPayload{
		RequestID: "follower-query",
		Statement: "other statement",
		HolderDID: "did:example:other",
	}
	if _, _, err := q.importRequest(active); err != nil {
		t.Fatal(err)
	}
	if _, _, err := q.importRequest(other); err != nil {
		t.Fatal(err)
	}
	if got, ok := q.currentRequest(); !ok || got.RequestID != active.RequestID {
		t.Fatalf("activate leader request got ok=%v request=%q", ok, got.RequestID)
	}

	q.claimRequest(other.RequestID)
	q.claimRequest(active.RequestID)

	if q.active == nil || q.active.RequestID != active.RequestID {
		t.Fatalf("claim replaced or cleared leader active request: %+v", q.active)
	}
	q.completeRequest(active.RequestID)
	if got, ok := q.currentRequest(); !ok || got.RequestID != other.RequestID {
		t.Fatalf("claimed follower request was not retained for retry; got ok=%v request=%q", ok, got.RequestID)
	}
}

func TestWaitForStoredRequestIsNotifiedByImport(t *testing.T) {
	q := newRequestQueue()
	request := queryPayload{
		RequestID: "wait-for-import",
		Statement: "statement",
		HolderDID: "did:example:wait",
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	type result struct {
		request queryPayload
		ok      bool
		err     error
	}
	resultCh := make(chan result, 1)
	go func() {
		got, ok, err := q.waitForStoredRequest(ctx, request.RequestID)
		resultCh <- result{request: got, ok: ok, err: err}
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
			t.Fatal("request waiter was not registered")
		}
		time.Sleep(time.Millisecond)
	}
	if _, _, err := q.importRequest(request); err != nil {
		t.Fatal(err)
	}

	got := <-resultCh
	if got.err != nil || !got.ok || got.request.RequestID != request.RequestID {
		t.Fatalf("wait result ok=%v request=%q err=%v", got.ok, got.request.RequestID, got.err)
	}
}

func TestWaitForStoredRequestCancellationRemovesWaiter(t *testing.T) {
	q := newRequestQueue()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, ok, err := q.waitForStoredRequest(ctx, "never-imported"); !errors.Is(err, context.Canceled) || ok {
		t.Fatalf("cancelled wait ok=%v err=%v", ok, err)
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.waiters) != 0 {
		t.Fatalf("cancelled waiter leaked: %+v", q.waiters)
	}
}

func TestCompleteBeforeImportSuppressesLateEnqueue(t *testing.T) {
	q := newRequestQueue()
	request := queryPayload{
		RequestID: "complete-before-import",
		Statement: "statement",
		HolderDID: "did:example:complete",
	}

	q.completeRequest(request.RequestID)
	if _, status, err := q.importRequest(request); err != nil || status != "done" {
		t.Fatalf("late import status=%q err=%v, want done", status, err)
	}
	if _, ok := q.storedRequest(request.RequestID); !ok {
		t.Fatal("completed late import did not preserve lookup payload")
	}
	if got, ok := q.currentRequest(); ok {
		t.Fatalf("completed request was enqueued by late import: %q", got.RequestID)
	}
}

func TestConcurrentCompleteAndImportNeverLeavesRequestPending(t *testing.T) {
	q := newRequestQueue()
	q.maxItems = 500
	q.maxPending = 500

	for i := 0; i < 250; i++ {
		request := queryPayload{
			RequestID: fmt.Sprintf("complete-concurrent-%d", i),
			Statement: "statement",
			HolderDID: fmt.Sprintf("did:example:complete:%d", i),
		}
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			if _, _, err := q.importRequest(request); err != nil {
				t.Errorf("import %s: %v", request.RequestID, err)
			}
		}()
		go func() {
			defer wg.Done()
			<-start
			q.completeRequest(request.RequestID)
		}()
		close(start)
		wg.Wait()
	}

	if got, ok := q.currentRequest(); ok {
		t.Fatalf("concurrent complete/import left request pending: %q", got.RequestID)
	}
}
