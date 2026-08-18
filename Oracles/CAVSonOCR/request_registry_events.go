//go:build !queue

package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	gethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
)

const cavsRequestRegistryABI = `[
  {"anonymous":false,"inputs":[
    {"indexed":true,"internalType":"bytes32","name":"requestID","type":"bytes32"},
    {"indexed":true,"internalType":"bytes32","name":"oracleSetID","type":"bytes32"},
    {"indexed":true,"internalType":"address","name":"requester","type":"address"},
    {"indexed":false,"internalType":"uint64","name":"nonce","type":"uint64"},
    {"indexed":false,"internalType":"uint64","name":"deadline","type":"uint64"},
    {"indexed":false,"internalType":"bytes32","name":"blobHash","type":"bytes32"},
    {"components":[
      {"internalType":"uint8","name":"oracleId","type":"uint8"},
      {"internalType":"bytes32","name":"ephemeralPublicKey","type":"bytes32"},
      {"internalType":"bytes12","name":"nonce","type":"bytes12"},
      {"internalType":"bytes","name":"wrappedARequestKey","type":"bytes"}
    ],"indexed":false,"internalType":"struct CAVSRequestRegistry.KeyEnvelope[]","name":"keyEnvelopes","type":"tuple[]"}
  ],"name":"CAVSRequestSubmitted","type":"event"}
]`

type cavsRequestKeyEnvelope struct {
	OracleID           uint8
	EphemeralPublicKey [32]byte
	Nonce              [12]byte
	WrappedARequestKey []byte
}

type cavsRequestSubmittedEvent struct {
	RequestID    common.Hash
	OracleSetID  common.Hash
	Requester    common.Address
	Nonce        uint64
	Deadline     uint64
	BlobHash     common.Hash
	KeyEnvelopes []cavsRequestKeyEnvelope
}

func parseCAVSRequestSubmittedLog(vLog gethtypes.Log) (cavsRequestSubmittedEvent, error) {
	contractABI, err := abi.JSON(strings.NewReader(cavsRequestRegistryABI))
	if err != nil {
		return cavsRequestSubmittedEvent{}, err
	}
	event := contractABI.Events["CAVSRequestSubmitted"]
	if len(vLog.Topics) != 4 || vLog.Topics[0] != event.ID {
		return cavsRequestSubmittedEvent{}, fmt.Errorf("not a CAVSRequestSubmitted log")
	}
	var out struct {
		Nonce        uint64                   `abi:"nonce"`
		Deadline     uint64                   `abi:"deadline"`
		BlobHash     common.Hash              `abi:"blobHash"`
		KeyEnvelopes []cavsRequestKeyEnvelope `abi:"keyEnvelopes"`
	}
	if err := contractABI.UnpackIntoInterface(&out, "CAVSRequestSubmitted", vLog.Data); err != nil {
		return cavsRequestSubmittedEvent{}, err
	}
	return cavsRequestSubmittedEvent{
		RequestID:    vLog.Topics[1],
		OracleSetID:  vLog.Topics[2],
		Requester:    common.BytesToAddress(vLog.Topics[3].Bytes()[12:]),
		Nonce:        out.Nonce,
		Deadline:     out.Deadline,
		BlobHash:     out.BlobHash,
		KeyEnvelopes: out.KeyEnvelopes,
	}, nil
}

func watchCAVSRequestSubmitted(ctx context.Context, eth *ethclient.Client, registry common.Address, out chan<- cavsRequestSubmittedEvent) error {
	contractABI, err := abi.JSON(strings.NewReader(cavsRequestRegistryABI))
	if err != nil {
		return err
	}
	logs := make(chan gethtypes.Log)
	query := ethereum.FilterQuery{
		Addresses: []common.Address{registry},
		Topics:    [][]common.Hash{{contractABI.Events["CAVSRequestSubmitted"].ID}},
	}
	sub, err := eth.SubscribeFilterLogs(ctx, query, logs)
	if err != nil {
		return err
	}
	defer sub.Unsubscribe()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-sub.Err():
			return err
		case vLog := <-logs:
			event, err := parseCAVSRequestSubmittedLog(vLog)
			if err != nil {
				continue
			}
			select {
			case out <- event:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
}

func decodeAndVerifyEncryptedEnvelope(payload []byte, keyEnvelopes []cavsRequestKeyEnvelope, expectedRequestID common.Hash) (encryptedRequestBlobPayload, []encryptedRequestKeyEnvelope, error) {
	var blobPayload encryptedRequestBlobPayload
	if err := json.Unmarshal(payload, &blobPayload); err != nil {
		return encryptedRequestBlobPayload{}, nil, err
	}
	converted := make([]encryptedRequestKeyEnvelope, 0, len(keyEnvelopes))
	for _, keyEnvelope := range keyEnvelopes {
		converted = append(converted, encryptedRequestKeyEnvelope{
			OracleID:           int(keyEnvelope.OracleID),
			EphemeralPublicKey: hex.EncodeToString(keyEnvelope.EphemeralPublicKey[:]),
			Nonce:              hex.EncodeToString(keyEnvelope.Nonce[:]),
			WrappedKey:         hex.EncodeToString(keyEnvelope.WrappedARequestKey),
		})
	}
	canonical, requestID, err := canonicalEncryptedEnvelope(blobPayload, converted)
	if err != nil {
		return encryptedRequestBlobPayload{}, nil, err
	}
	_ = canonical
	if common.HexToHash(requestID) != expectedRequestID {
		return encryptedRequestBlobPayload{}, nil, fmt.Errorf("requestID commitment mismatch")
	}
	return blobPayload, converted, nil
}

func queryPayloadFromDecryptedRequest(requestID string, req encryptedCAVSRequest) queryPayload {
	return queryPayload{
		RequestID:         strings.TrimSpace(requestID),
		OracleSetID:       req.OracleSetID,
		RequesterEndpoint: strings.TrimSpace(req.RequesterEndpoint),
		Statement:         req.Statement,
		StatementHash:     req.StatementHash,
		HolderDID:         req.HolderDID,
		Presentation:      compactRawJSON(req.Presentation),
	}
}
