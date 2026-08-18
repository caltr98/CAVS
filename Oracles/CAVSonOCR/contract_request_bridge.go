//go:build !queue

package main

import (
	"container/list"
	"context"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	gethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/smartcontractkit/libocr/commontypes"
)

const (
	defaultContractRequestPollInterval   = time.Second
	defaultContractRequestPendingRetry   = time.Second
	defaultContractRequestStartupTimeout = 15 * time.Second
	contractRequestLogRange              = 10
	contractRequestStartupLookback       = contractRequestLogRange - 1
	contractRequestRescanBlockCount      = 4

	// Reconciliation scans can be spread fairly widely because a required
	// subscription is the primary wake-up path. Blob retries stay close to one
	// second, so use a much smaller offset there.
	contractRequestReconciliationStagger = 137 * time.Millisecond
	contractRequestPendingRetryStagger   = 37 * time.Millisecond

	contractRequestRateLimitBackoffInitial = 15 * time.Second
	contractRequestRateLimitBackoffMax     = 5 * time.Minute

	// This is deliberately at least as large as the request queue's default
	// lifetime capacity. The bridge only rescans a four-block overlap, so IDs
	// older than this bounded recent window cannot be needed for ordinary
	// overlap deduplication. If an operator accepts more than 10k requests in
	// that tiny overlap, the queue capacity—not this cache—is already the
	// governing bound.
	defaultContractRequestIDCacheSize = 10000
)

type contractRequestBridgeConfig struct {
	pollInterval        time.Duration
	startupTimeout      time.Duration
	subscriptionRPCURL  string
	requireSubscription bool
}

type contractRequestLogSubscription struct {
	notify <-chan struct{}
	fatal  <-chan error
}

type contractRequestRateLimitBackoff struct {
	failures uint
}

// boundedRequestIDSet provides O(1) membership, insertion, deletion, and FIFO
// eviction. Both bridge ID sets are single-goroutine-owned, so no mutex is
// required. Keeping them bounded prevents one allocation per historical
// request from accumulating for the process lifetime.
type boundedRequestIDSet struct {
	max     int
	order   *list.List
	entries map[string]*list.Element
}

func newBoundedRequestIDSet(max int) *boundedRequestIDSet {
	if max <= 0 {
		max = defaultContractRequestIDCacheSize
	}
	return &boundedRequestIDSet{
		max:     max,
		order:   list.New(),
		entries: make(map[string]*list.Element, max),
	}
}

func (s *boundedRequestIDSet) contains(requestID string) bool {
	if s == nil {
		return false
	}
	_, ok := s.entries[requestID]
	return ok
}

func (s *boundedRequestIDSet) add(requestID string) {
	if s == nil || requestID == "" {
		return
	}
	if _, ok := s.entries[requestID]; ok {
		return
	}
	element := s.order.PushBack(requestID)
	s.entries[requestID] = element
	for len(s.entries) > s.max {
		oldest := s.order.Front()
		if oldest == nil {
			break
		}
		delete(s.entries, oldest.Value.(string))
		s.order.Remove(oldest)
	}
}

func (s *boundedRequestIDSet) remove(requestID string) {
	if s == nil {
		return
	}
	element, ok := s.entries[requestID]
	if !ok {
		return
	}
	delete(s.entries, requestID)
	s.order.Remove(element)
}

func (s *boundedRequestIDSet) len() int {
	if s == nil {
		return 0
	}
	return len(s.entries)
}

func (b *contractRequestRateLimitBackoff) reset() {
	b.failures = 0
}

func (b *contractRequestRateLimitBackoff) nextDelay() time.Duration {
	delay := contractRequestRateLimitBackoffInitial
	for i := uint(0); i < b.failures && delay < contractRequestRateLimitBackoffMax; i++ {
		if delay > contractRequestRateLimitBackoffMax/2 {
			delay = contractRequestRateLimitBackoffMax
			break
		}
		delay *= 2
	}
	if delay > contractRequestRateLimitBackoffMax {
		delay = contractRequestRateLimitBackoffMax
	}
	b.failures++
	return delay
}

func loadContractRequestBridgeConfig() (contractRequestBridgeConfig, error) {
	cfg := contractRequestBridgeConfig{
		pollInterval:   defaultContractRequestPollInterval,
		startupTimeout: defaultContractRequestStartupTimeout,
	}
	if raw, ok := envString("OCR_CONTRACT_SUBSCRIPTION_RPC_URL"); ok {
		cfg.subscriptionRPCURL = strings.TrimSpace(raw)
	}
	if required, ok, err := envBool("OCR_REQUIRE_CONTRACT_SUBSCRIPTION"); err != nil {
		return cfg, err
	} else if ok {
		cfg.requireSubscription = required
	}
	if raw, ok := envString("OCR_CONTRACT_REQUEST_POLL_INTERVAL"); ok {
		d, err := time.ParseDuration(raw)
		if err != nil {
			seconds, secondsErr := strconv.ParseFloat(raw, 64)
			if secondsErr != nil {
				return cfg, fmt.Errorf("parse OCR_CONTRACT_REQUEST_POLL_INTERVAL=%q: %w", raw, err)
			}
			d = time.Duration(seconds * float64(time.Second))
		}
		if d < time.Second {
			return cfg, fmt.Errorf("OCR_CONTRACT_REQUEST_POLL_INTERVAL must be >= 1s, got %s", d)
		}
		cfg.pollInterval = d
	}
	if raw, ok := envString("OCR_CONTRACT_REQUEST_STARTUP_TIMEOUT"); ok {
		d, err := time.ParseDuration(raw)
		if err != nil {
			seconds, secondsErr := strconv.ParseFloat(raw, 64)
			if secondsErr != nil {
				return cfg, fmt.Errorf("parse OCR_CONTRACT_REQUEST_STARTUP_TIMEOUT=%q: %w", raw, err)
			}
			d = time.Duration(seconds * float64(time.Second))
		}
		if d <= 0 {
			return cfg, fmt.Errorf("OCR_CONTRACT_REQUEST_STARTUP_TIMEOUT must be > 0, got %s", d)
		}
		cfg.startupTimeout = d
	}
	return cfg, nil
}

func startContractRequestQueueBridge(ctx context.Context, rpcURL string, registryAddress common.Address, beaconAPIURL string, queueURL string, localQueue *requestQueue, oracleID int, oraclePrivateKey [32]byte, metrics *metricRecorder) (<-chan error, error) {
	if strings.TrimSpace(rpcURL) == "" {
		return nil, fmt.Errorf("missing contract RPC URL for request bridge")
	}
	if registryAddress == (common.Address{}) {
		return nil, fmt.Errorf("missing request registry address for request bridge")
	}
	if strings.TrimSpace(queueURL) == "" && localQueue == nil {
		return nil, fmt.Errorf("missing queue backend for request bridge")
	}
	cfg, err := loadContractRequestBridgeConfig()
	if err != nil {
		return nil, err
	}
	subscriptionRPCURL := cfg.subscriptionRPCURL
	if subscriptionRPCURL == "" {
		// Preserve compatibility for deployments that already provide a ws://
		// OCR_CONTRACT_RPC_URL. Plain HTTP will cleanly fall back to polling.
		subscriptionRPCURL = rpcURL
	}
	if cfg.requireSubscription {
		transport := rpcTransport(subscriptionRPCURL)
		if transport != "ws" && transport != "wss" {
			return nil, fmt.Errorf(
				"OCR_REQUIRE_CONTRACT_SUBSCRIPTION requires ws/wss RPC, got %s",
				transport,
			)
		}
	}

	// Bound every network operation required to make the bridge ready. The
	// caller's context governs the bridge lifetime, while this child context is
	// used only for initial RPC handshakes. In particular, go-ethereum documents
	// that Subscribe's context controls setup but not the established stream.
	setupCtx, cancelSetup := context.WithTimeout(ctx, cfg.startupTimeout)
	defer cancelSetup()

	eth, err := ethclient.DialContext(setupCtx, rpcURL)
	if err != nil {
		return nil, fmt.Errorf("dial request registry RPC: %w", err)
	}
	httpClient := &http.Client{Timeout: 15 * time.Second}
	beaconClient, err := newBeaconBlobClient(resolveBeaconAPIURL(beaconAPIURL, rpcURL), httpClient)
	if err != nil {
		eth.Close()
		return nil, err
	}
	var subscriptionEth *ethclient.Client
	subscriptionTransport := rpcTransport(subscriptionRPCURL)
	if strings.TrimSpace(subscriptionRPCURL) != "" && subscriptionTransport != "http" && subscriptionTransport != "https" {
		subscriptionEth, err = ethclient.DialContext(setupCtx, subscriptionRPCURL)
		if err != nil {
			if cfg.requireSubscription {
				eth.Close()
				return nil, fmt.Errorf("dial required request-log subscription RPC: %w", err)
			}
			fmt.Printf("oracle=%d request bridge subscription RPC unavailable err=%v; falling back to interval polling\n", oracleID, err)
		}
	}
	if cfg.requireSubscription && subscriptionEth == nil {
		eth.Close()
		return nil, fmt.Errorf("required request-log subscription client is unavailable")
	}
	eventID, err := contractRequestSubmittedEventID()
	if err != nil {
		eth.Close()
		if subscriptionEth != nil {
			subscriptionEth.Close()
		}
		return nil, err
	}
	notify, subscriptionErrors, err := subscribeContractRequestLogs(
		setupCtx,
		ctx,
		subscriptionEth,
		registryAddress,
		eventID,
		oracleID,
		cfg.requireSubscription,
	)
	if err != nil {
		eth.Close()
		if subscriptionEth != nil {
			subscriptionEth.Close()
		}
		return nil, err
	}
	subscription := contractRequestLogSubscription{
		notify: notify,
		fatal:  subscriptionErrors,
	}
	fmt.Printf("oracle=%d request bridge config poll_interval=%s startup_timeout=%s subscription_transport=%s\n", oracleID, cfg.pollInterval, cfg.startupTimeout, subscriptionTransport)
	if strings.TrimSpace(beaconClient.baseURL) == "" {
		fmt.Printf("oracle=%d request bridge using local request blob cache dir=%s\n", oracleID, beaconClient.cacheDir)
	} else {
		fmt.Printf("oracle=%d request bridge using beacon api url=%s blob_id_mode=%s\n", oracleID, beaconClient.baseURL, beaconClient.blobIDMode)
	}
	done := make(chan error, 1)
	go func() {
		defer close(done)
		defer eth.Close()
		if subscriptionEth != nil {
			defer subscriptionEth.Close()
		}
		bridgeErr := pollContractRequestsIntoQueue(ctx, eth, registryAddress, beaconClient, queueURL, localQueue, oracleID, oraclePrivateKey, httpClient, metrics, cfg, subscription)
		if bridgeErr != nil && ctx.Err() == nil {
			fmt.Printf("oracle=%d contract request bridge stopped err=%v\n", oracleID, bridgeErr)
		}
		done <- bridgeErr
	}()
	return done, nil
}

func contractRequestSubmittedEventID() (common.Hash, error) {
	contractABI, err := abi.JSON(strings.NewReader(cavsRequestRegistryABI))
	if err != nil {
		return common.Hash{}, fmt.Errorf("parse CAVS request registry ABI: %w", err)
	}
	event, ok := contractABI.Events["CAVSRequestSubmitted"]
	if !ok {
		return common.Hash{}, fmt.Errorf("CAVS request registry ABI is missing CAVSRequestSubmitted")
	}
	return event.ID, nil
}

func pollContractRequestsIntoQueue(ctx context.Context, eth *ethclient.Client, registryAddress common.Address, beaconClient *beaconBlobClient, queueURL string, localQueue *requestQueue, oracleID int, oraclePrivateKey [32]byte, httpClient *http.Client, metrics *metricRecorder, cfg contractRequestBridgeConfig, subscription contractRequestLogSubscription) error {
	eventID, err := contractRequestSubmittedEventID()
	if err != nil {
		return err
	}
	requestIDCacheSize := envInt("OCR_CONTRACT_REQUEST_ID_CACHE_SIZE", defaultContractRequestIDCacheSize)
	processed := newBoundedRequestIDSet(requestIDCacheSize)
	pending := map[string]gethtypes.Log{}
	phaseInterventions := newBoundedRequestIDSet(requestIDCacheSize)
	var lastScanned uint64
	var rateLimitBackoff contractRequestRateLimitBackoff

	for {
		rateLimited := false
		// Snapshot retries before scanning. A stale/missing sidecar may consume
		// the full HTTP timeout, so scanning the current head first prevents one
		// old pending blob from delaying discovery of every newer request. IDs
		// added by this scan wait until the next iteration rather than being
		// fetched twice back-to-back.
		pendingRetries := sortedPendingContractRequestIDs(pending)
		if !rateLimited {
			if err := pollContractRequestRange(ctx, eth, registryAddress, eventID, &lastScanned, oracleID, oraclePrivateKey, beaconClient, queueURL, localQueue, httpClient, processed, pending, phaseInterventions, metrics, cfg); err != nil {
				fmt.Printf("oracle=%d request bridge poll error err=%v\n", oracleID, err)
				rateLimited = isContractRequestRateLimitError(err)
			}
		}
		if !rateLimited {
			if err := retryPendingContractRequests(ctx, eth, oracleID, oraclePrivateKey, beaconClient, queueURL, localQueue, httpClient, processed, pending, pendingRetries, phaseInterventions, metrics); err != nil {
				fmt.Printf("oracle=%d request bridge retry error err=%v\n", oracleID, err)
				rateLimited = isContractRequestRateLimitError(err)
			}
		}

		delay := cfg.pollInterval
		if rateLimited {
			delay = rateLimitBackoff.nextDelay()
			fmt.Printf("oracle=%d request bridge rate limited backoff=%s\n", oracleID, delay)
		} else {
			rateLimitBackoff.reset()
			delay = nextContractRequestPollDelay(cfg, oracleID, len(pending) > 0)
		}
		if err := waitContractRequestPoll(ctx, delay, subscription.notify, subscription.fatal); err != nil {
			return err
		}
	}
}

// subscribeContractRequestLogs opens a SubscribeFilterLogs stream on the
// registry's CAVSRequestSubmitted event and returns a channel that is pinged
// (coalesced, non-blocking) whenever a matching log arrives. setupCtx bounds only
// the initial RPC acknowledgement; lifetimeCtx owns the established stream. An
// optional subscription degrades to polling and self-heals after stream loss. A
// required subscription reports stream loss through the fatal channel so a
// causal benchmark cell fails instead of silently changing its pickup mechanism.
func subscribeContractRequestLogs(setupCtx context.Context, lifetimeCtx context.Context, eth *ethclient.Client, registryAddress common.Address, eventID common.Hash, oracleID int, required bool) (<-chan struct{}, <-chan error, error) {
	if eth == nil {
		err := fmt.Errorf("request bridge log subscription client unavailable")
		if required {
			return nil, nil, err
		}
		fmt.Printf("oracle=%d %v; falling back to interval polling\n", oracleID, err)
		return nil, nil, nil
	}
	query := ethereum.FilterQuery{
		Addresses: []common.Address{registryAddress},
		Topics:    [][]common.Hash{{eventID}},
	}
	logs := make(chan gethtypes.Log, 16)
	sub, err := eth.SubscribeFilterLogs(setupCtx, query, logs)
	if err != nil {
		if required {
			return nil, nil, fmt.Errorf("required request bridge log subscription: %w", err)
		}
		fmt.Printf("oracle=%d request bridge log subscription unavailable (%v); falling back to interval polling\n", oracleID, err)
		return nil, nil, nil
	}
	fmt.Printf("oracle=%d request bridge subscribed to CAVSRequestSubmitted logs for immediate pickup\n", oracleID)

	notify := make(chan struct{}, 1)
	var fatal chan error
	if required {
		fatal = make(chan error, 1)
	}
	wake := func() {
		select {
		case notify <- struct{}{}:
		default:
		}
	}
	go func() {
		backoff := time.Second
		for {
			select {
			case <-lifetimeCtx.Done():
				sub.Unsubscribe()
				return
			case <-logs:
				wake()
			case subErr := <-sub.Err():
				if subErr == nil {
					subErr = errors.New("subscription error channel closed")
				}
				sub.Unsubscribe()
				if required {
					fmt.Printf("oracle=%d required request bridge log subscription lost err=%v\n", oracleID, subErr)
					fatal <- fmt.Errorf("required request-log subscription lost: %w", subErr)
					return
				}
				fmt.Printf("oracle=%d request bridge log subscription error err=%v; re-subscribing\n", oracleID, subErr)
				// Wake the poll loop so nothing is missed during the gap.
				wake()
				for {
					select {
					case <-lifetimeCtx.Done():
						return
					case <-time.After(backoff):
					}
					newSub, resubErr := eth.SubscribeFilterLogs(lifetimeCtx, query, logs)
					if resubErr == nil {
						sub = newSub
						backoff = time.Second
						break
					}
					fmt.Printf("oracle=%d request bridge re-subscribe failed err=%v\n", oracleID, resubErr)
					if backoff < 30*time.Second {
						backoff *= 2
					}
				}
			}
		}
	}()
	return notify, fatal, nil
}

func nextContractRequestPollDelay(cfg contractRequestBridgeConfig, oracleID int, pending bool) time.Duration {
	if oracleID < 0 {
		oracleID = 0
	}
	if pending {
		delay := cfg.pollInterval
		if delay <= 0 || delay > defaultContractRequestPendingRetry {
			delay = defaultContractRequestPendingRetry
		}
		return delay + time.Duration(oracleID)*contractRequestPendingRetryStagger
	}
	if cfg.requireSubscription {
		return cfg.pollInterval + time.Duration(oracleID)*contractRequestReconciliationStagger
	}
	return cfg.pollInterval
}

func rpcTransport(rawURL string) string {
	value := strings.ToLower(strings.TrimSpace(rawURL))
	switch {
	case strings.HasPrefix(value, "ws://"):
		return "ws"
	case strings.HasPrefix(value, "wss://"):
		return "wss"
	case strings.HasPrefix(value, "http://"):
		return "http"
	case strings.HasPrefix(value, "https://"):
		return "https"
	case value == "":
		return "disabled"
	default:
		return "other"
	}
}

func waitContractRequestPoll(ctx context.Context, delay time.Duration, notify <-chan struct{}, subscriptionErrors <-chan error) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	case <-notify:
		// A new request log arrived; scan right away instead of waiting out the
		// full poll interval. notify is nil when no subscription is active, and a
		// receive from a nil channel simply never fires.
		return nil
	case err := <-subscriptionErrors:
		if err == nil {
			return fmt.Errorf("required request-log subscription stopped")
		}
		return err
	}
}

func sortedPendingContractRequestIDs(pending map[string]gethtypes.Log) []string {
	if len(pending) == 0 {
		return nil
	}
	requestIDs := make([]string, 0, len(pending))
	for requestID := range pending {
		requestIDs = append(requestIDs, requestID)
	}
	sort.Strings(requestIDs)
	return requestIDs
}

func retryPendingContractRequests(ctx context.Context, eth *ethclient.Client, oracleID int, oraclePrivateKey [32]byte, beaconClient *beaconBlobClient, queueURL string, localQueue *requestQueue, httpClient *http.Client, processed *boundedRequestIDSet, pending map[string]gethtypes.Log, requestIDs []string, phaseInterventions *boundedRequestIDSet, metrics *metricRecorder) error {
	for _, requestID := range requestIDs {
		vLog, stillPending := pending[requestID]
		if !stillPending {
			continue
		}
		if err := importContractRequestLog(ctx, eth, vLog, oracleID, oraclePrivateKey, beaconClient, queueURL, localQueue, httpClient, processed, phaseInterventions, metrics); err != nil {
			if !shouldRetryContractRequestImport(err) {
				fmt.Printf("oracle=%d request bridge drop terminal pending tx=%s requestId=%s err=%v\n", oracleID, vLog.TxHash.Hex(), requestID, err)
				delete(pending, requestID)
				continue
			}
			fmt.Printf("oracle=%d request bridge retry pending tx=%s requestId=%s err=%v\n", oracleID, vLog.TxHash.Hex(), requestID, err)
			if isContractRequestRateLimitError(err) {
				return err
			}
			continue
		}
		delete(pending, requestID)
	}
	return nil
}

func pollContractRequestRange(ctx context.Context, eth *ethclient.Client, registryAddress common.Address, eventID common.Hash, lastScanned *uint64, oracleID int, oraclePrivateKey [32]byte, beaconClient *beaconBlobClient, queueURL string, localQueue *requestQueue, httpClient *http.Client, processed *boundedRequestIDSet, pending map[string]gethtypes.Log, phaseInterventions *boundedRequestIDSet, metrics *metricRecorder, cfg contractRequestBridgeConfig) error {
	headerStart := time.Now()
	header, err := eth.HeaderByNumber(ctx, nil)
	metrics.recordDuration("EVENT_QUERY_HEADER", 0, 0, time.Since(headerStart))
	if err != nil {
		return err
	}
	if header == nil || header.Number == nil {
		return nil
	}
	latest := header.Number.Uint64()
	from, to, safeHead, ok := contractRequestScanRange(latest, *lastScanned)
	if !ok {
		return nil
	}

	fmt.Printf("oracle=%d request bridge scan blocks=%d-%d latest=%d safeHead=%d lastScanned=%d\n", oracleID, from, to, latest, safeHead, *lastScanned)

	logsStart := time.Now()
	logs, err := eth.FilterLogs(ctx, ethereum.FilterQuery{
		Addresses: []common.Address{registryAddress},
		Topics:    [][]common.Hash{{eventID}},
		FromBlock: new(big.Int).SetUint64(from),
		ToBlock:   new(big.Int).SetUint64(to),
	})
	metrics.recordDuration("EVENT_QUERY_LOGS", 0, len(logs), time.Since(logsStart))
	if err != nil {
		return err
	}
	fmt.Printf("oracle=%d request bridge scan result blocks=%d-%d logs=%d\n", oracleID, from, to, len(logs))
	sort.Slice(logs, func(i, j int) bool {
		if logs[i].BlockNumber != logs[j].BlockNumber {
			return logs[i].BlockNumber < logs[j].BlockNumber
		}
		if logs[i].TxIndex != logs[j].TxIndex {
			return logs[i].TxIndex < logs[j].TxIndex
		}
		return logs[i].Index < logs[j].Index
	})
	if err := importScannedContractRequestLogs(logs, oracleID, processed, pending, func(vLog gethtypes.Log) error {
		return importContractRequestLog(ctx, eth, vLog, oracleID, oraclePrivateKey, beaconClient, queueURL, localQueue, httpClient, processed, phaseInterventions, metrics)
	}); err != nil {
		return err
	}
	if to > *lastScanned {
		*lastScanned = to
	}
	return nil
}

func contractRequestScanRange(latest uint64, lastScanned uint64) (uint64, uint64, uint64, bool) {
	safeHead := latest
	if lastScanned != 0 && safeHead <= lastScanned {
		return 0, 0, safeHead, false
	}

	from := uint64(0)
	if lastScanned == 0 {
		if safeHead > contractRequestStartupLookback {
			from = safeHead - contractRequestStartupLookback
		}
	} else {
		if lastScanned >= contractRequestRescanBlockCount {
			from = lastScanned - contractRequestRescanBlockCount + 1
		}
	}
	if from > safeHead {
		return 0, 0, safeHead, false
	}
	to := safeHead
	if span := safeHead - from + 1; span > contractRequestLogRange {
		to = from + contractRequestLogRange - 1
	}
	return from, to, safeHead, true
}

func requestIDFromRequestSubmittedLog(vLog gethtypes.Log) (string, error) {
	event, err := parseCAVSRequestSubmittedLog(vLog)
	if err != nil {
		return "", err
	}
	return event.RequestID.Hex(), nil
}

func importScannedContractRequestLogs(logs []gethtypes.Log, oracleID int, processed *boundedRequestIDSet, pending map[string]gethtypes.Log, importLog func(gethtypes.Log) error) error {
	for _, vLog := range logs {
		requestID, parseErr := requestIDFromRequestSubmittedLog(vLog)
		if parseErr == nil && requestID != "" {
			if processed.contains(requestID) {
				fmt.Printf("oracle=%d request bridge skip processed requestId=%s block=%d tx=%s\n", oracleID, requestID, vLog.BlockNumber, vLog.TxHash.Hex())
				continue
			}
			if _, ok := pending[requestID]; ok {
				fmt.Printf("oracle=%d request bridge skip pending requestId=%s block=%d tx=%s\n", oracleID, requestID, vLog.BlockNumber, vLog.TxHash.Hex())
				continue
			}
		}
		if err := importLog(vLog); err != nil {
			if parseErr == nil && requestID != "" {
				if shouldRetryContractRequestImport(err) {
					pending[requestID] = vLog
					fmt.Printf("oracle=%d request bridge pending retry requestId=%s block=%d tx=%s err=%v\n", oracleID, requestID, vLog.BlockNumber, vLog.TxHash.Hex(), err)
				} else {
					fmt.Printf("oracle=%d request bridge drop terminal tx=%s requestId=%s err=%v\n", oracleID, vLog.TxHash.Hex(), requestID, err)
				}
			}
			fmt.Printf("oracle=%d request bridge import error tx=%s err=%v\n", oracleID, vLog.TxHash.Hex(), err)
			if isContractRequestRateLimitError(err) {
				return err
			}
		}
	}
	return nil
}

func importContractRequestLog(ctx context.Context, eth *ethclient.Client, vLog gethtypes.Log, oracleID int, oraclePrivateKey [32]byte, beaconClient *beaconBlobClient, queueURL string, localQueue *requestQueue, httpClient *http.Client, processed *boundedRequestIDSet, phaseInterventions *boundedRequestIDSet, metrics *metricRecorder) error {
	event, err := parseCAVSRequestSubmittedLog(vLog)
	if err != nil {
		return err
	}
	requestID := event.RequestID.Hex()
	if processed.contains(requestID) {
		return nil
	}
	if !eventTargetsOracle(event, oracleID) {
		return nil
	}
	if !phaseInterventions.contains(requestID) {
		done := requestProcessingBoundary(metrics, phaseEventPickup, commontypes.OracleID(oracleID), 0, requestID)
		if err := configuredPhaseSleeps.sleep(ctx, phaseEventPickup, metrics, 0); err != nil {
			done()
			return err
		}
		done()
		// Mark before any fallible blob work so a pending-import retry does not
		// record/apply the declared phase more than once.
		phaseInterventions.add(requestID)
	}
	payload, err := beaconClient.fetchBlobPayloadByTxHash(ctx, eth, vLog.TxHash, vLog.BlockHash, requestID, event.BlobHash)
	if err != nil {
		return fmt.Errorf("%w: %w", errContractRequestBlobRetrieval, err)
	}
	blobPayload, keyEnvelopes, err := decodeAndVerifyEncryptedEnvelope(payload, event.KeyEnvelopes, event.RequestID)
	if err != nil {
		return err
	}
	request, err := decryptCAVSRequest(blobPayload, keyEnvelopes, oracleID, oraclePrivateKey, event.OracleSetID.Hex(), time.Now())
	if err != nil {
		return err
	}
	if event.Deadline > 0 && uint64(time.Now().Unix()) > event.Deadline {
		return fmt.Errorf("request expired before import")
	}
	query := queryPayloadFromDecryptedRequest(requestID, request)
	if err := importRequest(ctx, httpClient, queueURL, localQueue, query); err != nil {
		return fmt.Errorf("%w: %w", errContractRequestQueueImport, err)
	}
	processed.add(requestID)
	// The intervention marker only prevents a retry from applying EVENT_PICKUP
	// twice while this request is pending. Once imported, processed performs all
	// future deduplication, so retaining this second request-ID set would grow
	// needlessly for the lifetime of a phase-sleep campaign.
	phaseInterventions.remove(requestID)
	fmt.Printf("oracle=%d imported contract request requestId=%s oracleSetID=%s source=request-registry\n", oracleID, requestID, event.OracleSetID.Hex())
	return nil
}

func shouldRetryContractRequestImport(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, errContractRequestQueueImport) || errors.Is(err, errContractRequestBlobRetrieval)
}

func isContractRequestRateLimitError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "429") ||
		strings.Contains(message, "alchemy") ||
		strings.Contains(message, "compute units") ||
		strings.Contains(message, "capacity") ||
		strings.Contains(message, "capacity exceeded") ||
		strings.Contains(message, "request rate exceeded") ||
		strings.Contains(message, "too many requests") ||
		strings.Contains(message, "rate limit") ||
		strings.Contains(message, "timeout") ||
		strings.Contains(message, "deadline exceeded") ||
		strings.Contains(message, "connection reset") ||
		strings.Contains(message, "econnreset") ||
		strings.Contains(message, "monthly capacity limit")
}

var errContractRequestQueueImport = errors.New("import request to queue")
var errContractRequestBlobRetrieval = errors.New("retrieve request blob from beacon sidecar")

func eventTargetsOracle(event cavsRequestSubmittedEvent, oracleID int) bool {
	for _, envelope := range event.KeyEnvelopes {
		if int(envelope.OracleID) == oracleID {
			return true
		}
	}
	return false
}
