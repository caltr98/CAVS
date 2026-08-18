//go:build !queue

package main

import (
	"context"
	"errors"
	"fmt"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	gethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/rpc"
)

func TestContractRequestScanRangeRevisitsDelayedFreshBlock(t *testing.T) {
	from, to, safeHead, ok := contractRequestScanRange(43, 40)
	if !ok || from != 37 || to != 43 || safeHead != 43 {
		t.Fatalf("first scan range = (%d, %d, %d, %v), want (37, 43, 43, true)", from, to, safeHead, ok)
	}

	delayedLog := mustRequestSubmittedLog(t, common.HexToHash("0xabc"), 42)
	processed := newBoundedRequestIDSet(100)
	pending := map[string]gethtypes.Log{}
	imported := 0
	importLog := func(vLog gethtypes.Log) error {
		requestID, err := requestIDFromRequestSubmittedLog(vLog)
		if err != nil {
			return err
		}
		imported++
		processed.add(requestID)
		return nil
	}

	// RPC log indexing can lag the head header. The empty result must not make
	// this recently safe block unreachable on the next poll.
	if err := importScannedContractRequestLogs(nil, 0, processed, pending, importLog); err != nil {
		t.Fatalf("empty first scan: %v", err)
	}
	if imported != 0 {
		t.Fatalf("empty first scan imported %d requests", imported)
	}

	from, to, safeHead, ok = contractRequestScanRange(44, 42)
	if !ok || from > delayedLog.BlockNumber || to < delayedLog.BlockNumber || safeHead != 44 {
		t.Fatalf("rescan range = (%d, %d, %d, %v), expected block %d inside safe head 44", from, to, safeHead, ok, delayedLog.BlockNumber)
	}
	if err := importScannedContractRequestLogs([]gethtypes.Log{delayedLog}, 0, processed, pending, importLog); err != nil {
		t.Fatalf("delayed scan: %v", err)
	}
	if imported != 1 {
		t.Fatalf("delayed log imported %d times, want 1", imported)
	}
}

func TestImportScannedContractRequestLogsSkipsOverlapDuplicate(t *testing.T) {
	vLog := mustRequestSubmittedLog(t, common.HexToHash("0xdef"), 55)
	processed := newBoundedRequestIDSet(100)
	pending := map[string]gethtypes.Log{}
	imported := 0
	importLog := func(vLog gethtypes.Log) error {
		requestID, err := requestIDFromRequestSubmittedLog(vLog)
		if err != nil {
			return err
		}
		imported++
		processed.add(requestID)
		return nil
	}

	if err := importScannedContractRequestLogs([]gethtypes.Log{vLog}, 1, processed, pending, importLog); err != nil {
		t.Fatalf("first overlapped scan: %v", err)
	}
	if err := importScannedContractRequestLogs([]gethtypes.Log{vLog}, 1, processed, pending, importLog); err != nil {
		t.Fatalf("second overlapped scan: %v", err)
	}
	if imported != 1 {
		t.Fatalf("overlapped log imported %d times, want 1", imported)
	}
}

func TestImportScannedContractRequestLogsKeepsBlobRetrievalPending(t *testing.T) {
	requestID := common.HexToHash("0x1234")
	vLog := mustRequestSubmittedLog(t, requestID, 77)
	processed := newBoundedRequestIDSet(100)
	pending := map[string]gethtypes.Log{}
	attempts := 0

	if err := importScannedContractRequestLogs([]gethtypes.Log{vLog}, 2, processed, pending, func(gethtypes.Log) error {
		attempts++
		return fmt.Errorf("%w: sidecar not indexed yet", errContractRequestBlobRetrieval)
	}); err != nil {
		t.Fatalf("sidecar indexing retry: %v", err)
	}

	if _, ok := pending[requestID.Hex()]; !ok {
		t.Fatalf("expected request %s to remain pending after transient blob retrieval failure", requestID.Hex())
	}
	if processed.len() != 0 {
		t.Fatalf("expected pending request not to be marked processed, got %d processed entries", processed.len())
	}
	if err := importScannedContractRequestLogs([]gethtypes.Log{vLog}, 2, processed, pending, func(gethtypes.Log) error {
		attempts++
		return nil
	}); err != nil {
		t.Fatalf("overlap while pending: %v", err)
	}
	if attempts != 1 {
		t.Fatalf("overlap retried a pending request, got %d import attempts, want 1", attempts)
	}
}

func TestContractRequestScanRangeSkipsStableSafeHead(t *testing.T) {
	_, _, safeHead, ok := contractRequestScanRange(42, 42)
	if ok || safeHead != 42 {
		t.Fatalf("stable safe-head scan returned safeHead=%d ok=%v, want safeHead=42 ok=false", safeHead, ok)
	}
}

func TestContractRequestScanRangeInitialQueryHonorsProviderLimit(t *testing.T) {
	from, to, safeHead, ok := contractRequestScanRange(1000, 0)
	if !ok || from != 991 || to != 1000 || safeHead != 1000 {
		t.Fatalf("initial scan range = (%d, %d, %d, %v), want (991, 1000, 1000, true)", from, to, safeHead, ok)
	}
}

func TestLoadContractRequestBridgeConfigFromEnv(t *testing.T) {
	t.Setenv("OCR_CONTRACT_REQUEST_POLL_INTERVAL", "3s")
	t.Setenv("OCR_CONTRACT_REQUEST_STARTUP_TIMEOUT", "4s")
	t.Setenv("OCR_CONTRACT_SUBSCRIPTION_RPC_URL", "ws://host.docker.internal:8545")
	t.Setenv("OCR_REQUIRE_CONTRACT_SUBSCRIPTION", "true")

	cfg, err := loadContractRequestBridgeConfig()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if cfg.pollInterval != 3*time.Second {
		t.Fatalf("poll interval = %s, want 3s", cfg.pollInterval)
	}
	if cfg.startupTimeout != 4*time.Second {
		t.Fatalf("startup timeout = %s, want 4s", cfg.startupTimeout)
	}
	if cfg.subscriptionRPCURL != "ws://host.docker.internal:8545" {
		t.Fatalf("subscription RPC URL = %q", cfg.subscriptionRPCURL)
	}
	if !cfg.requireSubscription {
		t.Fatal("required subscription flag was not loaded")
	}
}

func TestRPCTransport(t *testing.T) {
	tests := map[string]string{
		"ws://localhost:8545":     "ws",
		"wss://example.invalid":   "wss",
		"http://localhost:8545":   "http",
		"https://example.invalid": "https",
		"":                        "disabled",
	}
	for input, want := range tests {
		if got := rpcTransport(input); got != want {
			t.Errorf("rpcTransport(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestLoadContractRequestBridgeConfigDefaults(t *testing.T) {
	cfg, err := loadContractRequestBridgeConfig()
	if err != nil {
		t.Fatalf("load default config: %v", err)
	}
	if cfg.pollInterval != time.Second {
		t.Fatalf("poll interval = %s, want 1s", cfg.pollInterval)
	}
	if cfg.startupTimeout != defaultContractRequestStartupTimeout {
		t.Fatalf("startup timeout = %s, want %s", cfg.startupTimeout, defaultContractRequestStartupTimeout)
	}
	if cfg.requireSubscription {
		t.Fatal("subscription must remain optional by default")
	}
}

func TestLoadContractRequestBridgeConfigRejectsInvalidStartupTimeout(t *testing.T) {
	for _, value := range []string{"not-a-duration", "0s", "-1s"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("OCR_CONTRACT_REQUEST_STARTUP_TIMEOUT", value)
			if _, err := loadContractRequestBridgeConfig(); err == nil {
				t.Fatalf("startup timeout %q was accepted", value)
			}
		})
	}
}

func TestStartContractRequestQueueBridgeRejectsHTTPForRequiredSubscription(t *testing.T) {
	t.Setenv("OCR_REQUIRE_CONTRACT_SUBSCRIPTION", "true")
	t.Setenv("OCR_CONTRACT_SUBSCRIPTION_RPC_URL", "http://127.0.0.1:8545")

	_, err := startContractRequestQueueBridge(
		context.Background(),
		"http://127.0.0.1:8545",
		common.HexToAddress("0x1234"),
		"",
		"",
		newRequestQueue(),
		0,
		[32]byte{},
		nil,
	)
	if err == nil || !strings.Contains(err.Error(), "requires ws/wss RPC") {
		t.Fatalf("strict HTTP subscription error = %v, want ws/wss rejection", err)
	}
}

func TestNextContractRequestPollDelay(t *testing.T) {
	required := contractRequestBridgeConfig{
		pollInterval:        30 * time.Second,
		requireSubscription: true,
	}
	optional := contractRequestBridgeConfig{
		pollInterval: time.Second,
	}

	if got, want := nextContractRequestPollDelay(required, 3, false), 30*time.Second+3*contractRequestReconciliationStagger; got != want {
		t.Fatalf("required reconciliation delay = %s, want %s", got, want)
	}
	if got, want := nextContractRequestPollDelay(required, 3, true), time.Second+3*contractRequestPendingRetryStagger; got != want {
		t.Fatalf("pending retry delay = %s, want %s", got, want)
	}
	if got := nextContractRequestPollDelay(optional, 3, false); got != time.Second {
		t.Fatalf("optional reconciliation delay = %s, want 1s", got)
	}
	if got, want := nextContractRequestPollDelay(optional, 3, true), time.Second+3*contractRequestPendingRetryStagger; got != want {
		t.Fatalf("optional pending retry delay = %s, want %s", got, want)
	}
	if got := nextContractRequestPollDelay(required, -1, true); got != time.Second {
		t.Fatalf("negative oracle pending delay = %s, want 1s", got)
	}
}

func TestWaitContractRequestPollPropagatesRequiredSubscriptionError(t *testing.T) {
	want := errors.New("subscription lost")
	fatal := make(chan error, 1)
	fatal <- want

	got := waitContractRequestPoll(context.Background(), time.Hour, nil, fatal)
	if !errors.Is(got, want) {
		t.Fatalf("wait error = %v, want %v", got, want)
	}
}

type requestLogSubscriptionTestService struct {
	delay  time.Duration
	err    error
	called chan struct{}
	once   sync.Once
}

func (s *requestLogSubscriptionTestService) Logs(ctx context.Context, _ map[string]any) (*rpc.Subscription, error) {
	s.once.Do(func() {
		if s.called != nil {
			close(s.called)
		}
	})
	if s.delay > 0 {
		timer := time.NewTimer(s.delay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	if s.err != nil {
		return nil, s.err
	}
	notifier, supported := rpc.NotifierFromContext(ctx)
	if !supported {
		return nil, rpc.ErrNotificationsUnsupported
	}
	return notifier.CreateSubscription(), nil
}

func newRequestLogSubscriptionTestServer(t *testing.T, service *requestLogSubscriptionTestService) (string, func()) {
	t.Helper()
	rpcServer := rpc.NewServer()
	if err := rpcServer.RegisterName("eth", service); err != nil {
		t.Fatalf("register test eth RPC service: %v", err)
	}
	httpServer := httptest.NewServer(rpcServer.WebsocketHandler([]string{"*"}))
	var closeOnce sync.Once
	closeServer := func() {
		closeOnce.Do(func() {
			httpServer.Close()
			rpcServer.Stop()
		})
	}
	t.Cleanup(closeServer)
	return "ws" + strings.TrimPrefix(httpServer.URL, "http"), closeServer
}

func TestStartContractRequestQueueBridgePropagatesRequiredSubscriptionLoss(t *testing.T) {
	service := &requestLogSubscriptionTestService{}
	wsURL, closeServer := newRequestLogSubscriptionTestServer(t, service)
	t.Setenv("OCR_REQUIRE_CONTRACT_SUBSCRIPTION", "true")
	t.Setenv("OCR_CONTRACT_REQUEST_STARTUP_TIMEOUT", "2s")
	t.Setenv("OCR_CONTRACT_REQUEST_POLL_INTERVAL", "30s")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done, err := startContractRequestQueueBridge(
		ctx,
		wsURL,
		common.HexToAddress("0x1234"),
		"",
		"",
		newRequestQueue(),
		0,
		[32]byte{},
		nil,
	)
	if err != nil {
		t.Fatalf("start strict bridge: %v", err)
	}
	closeServer()

	select {
	case bridgeErr := <-done:
		if bridgeErr == nil || !strings.Contains(bridgeErr.Error(), "required request-log subscription lost") {
			t.Fatalf("bridge error = %v, want required subscription loss", bridgeErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("bridge did not propagate required subscription loss")
	}
}

func TestStartContractRequestQueueBridgeWaitsForRequiredSubscription(t *testing.T) {
	const subscriptionDelay = 75 * time.Millisecond
	service := &requestLogSubscriptionTestService{
		delay:  subscriptionDelay,
		called: make(chan struct{}),
	}
	wsURL, _ := newRequestLogSubscriptionTestServer(t, service)
	t.Setenv("OCR_REQUIRE_CONTRACT_SUBSCRIPTION", "true")
	t.Setenv("OCR_CONTRACT_REQUEST_STARTUP_TIMEOUT", "2s")
	t.Setenv("OCR_CONTRACT_REQUEST_POLL_INTERVAL", "30s")

	ctx, cancel := context.WithCancel(context.Background())
	start := time.Now()
	done, err := startContractRequestQueueBridge(
		ctx,
		wsURL,
		common.HexToAddress("0x1234"),
		"",
		"",
		newRequestQueue(),
		0,
		[32]byte{},
		nil,
	)
	elapsed := time.Since(start)
	if err != nil {
		cancel()
		t.Fatalf("start strict bridge: %v", err)
	}
	if elapsed < subscriptionDelay {
		cancel()
		t.Fatalf("bridge returned after %s before %s subscription setup completed", elapsed, subscriptionDelay)
	}
	select {
	case <-service.called:
	default:
		cancel()
		t.Fatal("bridge returned before the subscription RPC was called")
	}

	cancel()
	select {
	case bridgeErr := <-done:
		if !errors.Is(bridgeErr, context.Canceled) {
			t.Fatalf("bridge shutdown error = %v, want context.Canceled", bridgeErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("bridge did not stop after context cancellation")
	}
}

func TestStartContractRequestQueueBridgePropagatesInitialSubscriptionError(t *testing.T) {
	service := &requestLogSubscriptionTestService{
		err: errors.New("subscription rejected"),
	}
	wsURL, _ := newRequestLogSubscriptionTestServer(t, service)
	t.Setenv("OCR_REQUIRE_CONTRACT_SUBSCRIPTION", "true")
	t.Setenv("OCR_CONTRACT_REQUEST_STARTUP_TIMEOUT", "2s")

	done, err := startContractRequestQueueBridge(
		context.Background(),
		wsURL,
		common.HexToAddress("0x1234"),
		"",
		"",
		newRequestQueue(),
		0,
		[32]byte{},
		nil,
	)
	if done != nil {
		t.Fatal("failed strict bridge returned a done channel")
	}
	if err == nil || !strings.Contains(err.Error(), "subscription rejected") {
		t.Fatalf("initial subscription error = %v, want propagated rejection", err)
	}
}

func TestStartContractRequestQueueBridgeBoundsInitialSubscriptionSetup(t *testing.T) {
	service := &requestLogSubscriptionTestService{
		delay: time.Hour,
	}
	wsURL, _ := newRequestLogSubscriptionTestServer(t, service)
	t.Setenv("OCR_REQUIRE_CONTRACT_SUBSCRIPTION", "true")
	t.Setenv("OCR_CONTRACT_REQUEST_STARTUP_TIMEOUT", "80ms")

	start := time.Now()
	done, err := startContractRequestQueueBridge(
		context.Background(),
		wsURL,
		common.HexToAddress("0x1234"),
		"",
		"",
		newRequestQueue(),
		0,
		[32]byte{},
		nil,
	)
	elapsed := time.Since(start)
	if done != nil {
		t.Fatal("timed-out strict bridge returned a done channel")
	}
	if err == nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("subscription setup error = %v, want context deadline exceeded", err)
	}
	if elapsed > time.Second {
		t.Fatalf("80ms startup timeout returned after %s", elapsed)
	}
}

func TestImportScannedContractRequestLogsStopsOnRateLimit(t *testing.T) {
	firstID := common.HexToHash("0x101")
	secondID := common.HexToHash("0x102")
	logs := []gethtypes.Log{
		mustRequestSubmittedLog(t, firstID, 80),
		mustRequestSubmittedLog(t, secondID, 81),
	}
	pending := map[string]gethtypes.Log{}
	calls := 0

	err := importScannedContractRequestLogs(logs, 3, newBoundedRequestIDSet(100), pending, func(gethtypes.Log) error {
		calls++
		return fmt.Errorf("%w: http 429 Too Many Requests", errContractRequestBlobRetrieval)
	})
	if !isContractRequestRateLimitError(err) {
		t.Fatalf("rate-limited import returned %v, want a detected rate-limit error", err)
	}
	if calls != 1 {
		t.Fatalf("rate-limited scan attempted %d imports, want 1", calls)
	}
	if _, ok := pending[firstID.Hex()]; !ok {
		t.Fatalf("rate-limited request %s was not retained as pending", firstID.Hex())
	}
	if _, ok := pending[secondID.Hex()]; ok {
		t.Fatalf("request %s should not be attempted after a rate limit", secondID.Hex())
	}
}

func TestContractRequestRateLimitBackoff(t *testing.T) {
	var backoff contractRequestRateLimitBackoff
	want := []time.Duration{
		15 * time.Second,
		30 * time.Second,
		time.Minute,
		2 * time.Minute,
		4 * time.Minute,
		5 * time.Minute,
		5 * time.Minute,
	}
	for i, expected := range want {
		if got := backoff.nextDelay(); got != expected {
			t.Fatalf("backoff attempt %d = %s, want %s", i+1, got, expected)
		}
	}
	backoff.reset()
	if got := backoff.nextDelay(); got != contractRequestRateLimitBackoffInitial {
		t.Fatalf("reset backoff = %s, want %s", got, contractRequestRateLimitBackoffInitial)
	}
}

func TestBoundedRequestIDSetEvictsOldestAndSupportsReinsert(t *testing.T) {
	set := newBoundedRequestIDSet(2)
	set.add("one")
	set.add("two")
	set.add("three")
	if set.contains("one") {
		t.Fatal("oldest request ID was not evicted")
	}
	if !set.contains("two") || !set.contains("three") || set.len() != 2 {
		t.Fatalf("unexpected bounded set contents, len=%d", set.len())
	}

	set.remove("two")
	set.add("two")
	set.add("four")
	if set.contains("three") {
		t.Fatal("FIFO order was corrupted after remove/reinsert")
	}
	if !set.contains("two") || !set.contains("four") || set.len() != 2 {
		t.Fatalf("unexpected bounded set after reinsert, len=%d", set.len())
	}
}

func TestPendingContractRequestSnapshotIsSortedAndStable(t *testing.T) {
	pending := map[string]gethtypes.Log{
		"three": {},
		"one":   {},
		"two":   {},
	}
	got := sortedPendingContractRequestIDs(pending)
	want := []string{"one", "three", "two"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("pending snapshot=%v, want %v", got, want)
	}
	pending["later"] = gethtypes.Log{}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("snapshot changed after map mutation: %v", got)
	}
}

func TestShouldRetryContractRequestImport(t *testing.T) {
	t.Run("beacon blob retrieval is retryable", func(t *testing.T) {
		err := fmt.Errorf("%w: http 404", errContractRequestBlobRetrieval)
		if !shouldRetryContractRequestImport(err) {
			t.Fatalf("expected beacon blob retrieval error to be retryable")
		}
	})

	t.Run("queue import error is retryable", func(t *testing.T) {
		err := fmt.Errorf("%w: %w", errContractRequestQueueImport, errors.New("queue http 503"))
		if !shouldRetryContractRequestImport(err) {
			t.Fatalf("expected queue import error to be retryable")
		}
	})

	t.Run("auth failure is terminal", func(t *testing.T) {
		err := errors.New("unwrap AEncryKey: chacha20poly1305: message authentication failed")
		if shouldRetryContractRequestImport(err) {
			t.Fatalf("expected auth failure to be terminal")
		}
	})

	t.Run("expired request is terminal", func(t *testing.T) {
		err := errors.New("request expired before import")
		if shouldRetryContractRequestImport(err) {
			t.Fatalf("expected expired request to be terminal")
		}
	})
}

func TestIsContractRequestRateLimitError(t *testing.T) {
	for _, err := range []error{
		errors.New("429 Too Many Requests"),
		errors.New("Monthly capacity limit exceeded"),
		errors.New("rpc rate limit"),
	} {
		if !isContractRequestRateLimitError(err) {
			t.Fatalf("expected %q to be detected as rate limited", err)
		}
	}
	if isContractRequestRateLimitError(errors.New("beacon sidecar not indexed yet")) {
		t.Fatalf("ordinary transient error classified as rate limited")
	}
}

func mustRequestSubmittedLog(t *testing.T, requestID common.Hash, blockNumber uint64) gethtypes.Log {
	t.Helper()
	contractABI, err := abi.JSON(strings.NewReader(cavsRequestRegistryABI))
	if err != nil {
		t.Fatalf("parse registry ABI: %v", err)
	}
	event := contractABI.Events["CAVSRequestSubmitted"]
	data, err := event.Inputs.NonIndexed().Pack(
		uint64(1),
		uint64(2),
		common.HexToHash("0x01"),
		[]cavsRequestKeyEnvelope{},
	)
	if err != nil {
		t.Fatalf("pack registry event: %v", err)
	}
	return gethtypes.Log{
		BlockNumber: blockNumber,
		TxHash:      common.HexToHash("0xbeef"),
		Topics: []common.Hash{
			event.ID,
			requestID,
			common.HexToHash("0xfeed"),
			common.BytesToHash(common.HexToAddress("0x1234").Bytes()),
		},
		Data: data,
	}
}
