package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

func getCurrentRequest(ctx context.Context, client *http.Client, queueURL string, localQueue *requestQueue) (queryPayload, bool, error) {
	if localQueue != nil {
		request, ok := localQueue.currentRequest()
		return request, ok, nil
	}
	if strings.TrimSpace(queueURL) == "" {
		return queryPayload{}, false, nil
	}
	return getCurrentRequestFromQueue(ctx, client, queueURL)
}

func getStoredRequest(ctx context.Context, client *http.Client, queueURL string, localQueue *requestQueue, requestID string) (queryPayload, bool, error) {
	if localQueue != nil {
		request, ok := localQueue.storedRequest(requestID)
		return request, ok, nil
	}
	if strings.TrimSpace(queueURL) == "" {
		return queryPayload{}, false, nil
	}
	return getStoredRequestFromQueue(ctx, client, queueURL, requestID)
}

func postObservation(ctx context.Context, client *http.Client, queueURL string, localQueue *requestQueue, requestID string, observation storedObservation) error {
	if localQueue != nil {
		localQueue.recordObservation(requestID, observation.OracleID, observation.SeqNr, observation)
		return nil
	}
	if strings.TrimSpace(queueURL) == "" {
		return nil
	}
	return postObservationToQueue(ctx, client, queueURL, requestID, observation)
}

func importRequest(ctx context.Context, client *http.Client, queueURL string, localQueue *requestQueue, request queryPayload) error {
	if localQueue != nil {
		_, _, err := localQueue.importRequest(request)
		return err
	}
	if strings.TrimSpace(queueURL) == "" {
		return nil
	}
	return importRequestToQueue(ctx, client, queueURL, request)
}

func postResult(ctx context.Context, client *http.Client, queueURL string, localQueue *requestQueue, out outcomePayload) error {
	if localQueue != nil {
		localQueue.storeResult(out.RequestID, out)
		return nil
	}
	if strings.TrimSpace(queueURL) == "" {
		return nil
	}
	return postResultToQueue(ctx, client, queueURL, out)
}

func postCompletion(ctx context.Context, client *http.Client, queueURL string, localQueue *requestQueue, requestID string) error {
	if localQueue != nil {
		localQueue.completeRequest(requestID)
		return nil
	}
	if strings.TrimSpace(queueURL) == "" {
		return nil
	}
	return postCompletionToQueue(ctx, client, queueURL, requestID)
}

func getCurrentRequestFromQueue(ctx context.Context, client *http.Client, queueURL string) (queryPayload, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(queueURL, "/")+"/requests/current", nil)
	if err != nil {
		return queryPayload{}, false, err
	}
	setQueueAuthorization(req)
	resp, err := client.Do(req)
	if err != nil {
		return queryPayload{}, false, err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusNoContent {
		return queryPayload{}, false, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return queryPayload{}, false, fmt.Errorf("queue http %d", resp.StatusCode)
	}

	var q queryPayload
	if err := json.NewDecoder(resp.Body).Decode(&q); err != nil {
		return queryPayload{}, false, err
	}
	return q, true, nil
}

func getStoredRequestFromQueue(ctx context.Context, client *http.Client, queueURL string, requestID string) (queryPayload, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(queueURL, "/")+"/requests/"+requestID+"/query", nil)
	if err != nil {
		return queryPayload{}, false, err
	}
	setQueueAuthorization(req)
	resp, err := client.Do(req)
	if err != nil {
		return queryPayload{}, false, err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusNotFound {
		return queryPayload{}, false, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return queryPayload{}, false, fmt.Errorf("queue http %d", resp.StatusCode)
	}

	var q queryPayload
	if err := json.NewDecoder(resp.Body).Decode(&q); err != nil {
		return queryPayload{}, false, err
	}
	return q, true, nil
}

func postObservationToQueue(ctx context.Context, client *http.Client, queueURL string, requestID string, observation storedObservation) error {
	body, err := json.Marshal(observation)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(queueURL, "/")+"/requests/"+requestID+"/observations", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	setQueueAuthorization(req)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		bodyBytes, _ := boundedReadAll(resp.Body, defaultMaxErrorBodyBytes)
		return fmt.Errorf("queue http %d: %s", resp.StatusCode, strings.TrimSpace(string(bodyBytes)))
	}
	return nil
}

func importRequestToQueue(ctx context.Context, client *http.Client, queueURL string, request queryPayload) error {
	body, err := json.Marshal(request)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(queueURL, "/")+"/requests/import", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	setQueueAuthorization(req)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		bodyBytes, _ := boundedReadAll(resp.Body, defaultMaxErrorBodyBytes)
		return fmt.Errorf("queue http %d: %s", resp.StatusCode, strings.TrimSpace(string(bodyBytes)))
	}
	return nil
}

func postResultToQueue(ctx context.Context, client *http.Client, queueURL string, out outcomePayload) error {
	if strings.TrimSpace(out.RequestID) == "" {
		return nil
	}
	body, err := json.Marshal(out)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(queueURL, "/")+"/requests/"+out.RequestID+"/result", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	setQueueAuthorization(req)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		bodyBytes, _ := boundedReadAll(resp.Body, defaultMaxErrorBodyBytes)
		return fmt.Errorf("queue http %d: %s", resp.StatusCode, strings.TrimSpace(string(bodyBytes)))
	}
	return nil
}

func postCompletionToQueue(ctx context.Context, client *http.Client, queueURL string, requestID string) error {
	if strings.TrimSpace(requestID) == "" {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(queueURL, "/")+"/requests/"+requestID+"/complete", http.NoBody)
	if err != nil {
		return err
	}
	setQueueAuthorization(req)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		bodyBytes, _ := boundedReadAll(resp.Body, defaultMaxErrorBodyBytes)
		return fmt.Errorf("queue http %d: %s", resp.StatusCode, strings.TrimSpace(string(bodyBytes)))
	}
	return nil
}

func setQueueAuthorization(req *http.Request) {
	if token := queueAuthToken(); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
}
