//go:build !queue

package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/crypto"
	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/hkdf"
)

const encryptedRequestVersion = "cavs-request-v1"

type encryptedCAVSRequest struct {
	Version           string          `json:"version"`
	OracleSetID       string          `json:"oracleSetID"`
	RequesterEndpoint string          `json:"requesterEndpoint,omitempty"`
	HolderDID         string          `json:"holderDid"`
	Statement         string          `json:"statement,omitempty"`
	StatementHash     string          `json:"statementHash"`
	Presentation      json.RawMessage `json:"presentation,omitempty"`
	Nonce             string          `json:"nonce"`
	Deadline          int64           `json:"deadline"`
}

type requestRecipient struct {
	OracleID  int
	OEncryKey [32]byte
}

type encryptedRequestKeyEnvelope struct {
	OracleID           int    `json:"oracleId"`
	EphemeralPublicKey string `json:"ephemeralPublicKey"`
	Nonce              string `json:"nonce"`
	WrappedKey         string `json:"wrappedKey"`
}

type encryptedRequestBlobPayload struct {
	Version     string `json:"version"`
	OracleSetID string `json:"oracleSetID"`
	Algorithm   string `json:"algorithm"`
	Nonce       string `json:"nonce"`
	Deadline    int64  `json:"deadline"`
	Ciphertext  string `json:"ciphertext"`
}

type encryptedRequestEnvelope struct {
	Version      string                        `json:"version"`
	OracleSetID  string                        `json:"oracleSetID"`
	Algorithm    string                        `json:"algorithm"`
	Deadline     int64                         `json:"deadline"`
	BlobPayload  encryptedRequestBlobPayload   `json:"blobPayload"`
	KeyEnvelopes []encryptedRequestKeyEnvelope `json:"keyEnvelopes"`
}

func newEncryptedCAVSRequest(oracleSetID string, requesterEndpoint string, holderDID string, statement string, statementHash string, presentation json.RawMessage, nonce string, deadline int64) encryptedCAVSRequest {
	if strings.TrimSpace(statementHash) == "" && strings.TrimSpace(statement) != "" {
		statementHash = statementHashHex(statement)
	}
	return encryptedCAVSRequest{
		Version:           encryptedRequestVersion,
		OracleSetID:       strings.TrimSpace(oracleSetID),
		RequesterEndpoint: strings.TrimSpace(requesterEndpoint),
		HolderDID:         strings.TrimSpace(holderDID),
		Statement:         strings.TrimSpace(statement),
		StatementHash:     strings.TrimSpace(statementHash),
		Presentation:      compactRawJSON(presentation),
		Nonce:             strings.TrimSpace(nonce),
		Deadline:          deadline,
	}
}

func encryptCAVSRequest(req encryptedCAVSRequest, recipients []requestRecipient) (encryptedRequestBlobPayload, []encryptedRequestKeyEnvelope, string, []byte, error) {
	if len(recipients) == 0 {
		return encryptedRequestBlobPayload{}, nil, "", nil, fmt.Errorf("no request recipients")
	}
	req.Version = encryptedRequestVersion
	if req.StatementHash == "" && req.Statement != "" {
		req.StatementHash = statementHashHex(req.Statement)
	}
	req.Presentation = compactRawJSON(req.Presentation)
	payload, err := json.Marshal(req)
	if err != nil {
		return encryptedRequestBlobPayload{}, nil, "", nil, err
	}

	aEncryKey := make([]byte, chacha20poly1305.KeySize)
	if _, err := io.ReadFull(rand.Reader, aEncryKey); err != nil {
		return encryptedRequestBlobPayload{}, nil, "", nil, err
	}
	payloadNonce := make([]byte, chacha20poly1305.NonceSize)
	if _, err := io.ReadFull(rand.Reader, payloadNonce); err != nil {
		return encryptedRequestBlobPayload{}, nil, "", nil, err
	}
	aead, err := chacha20poly1305.New(aEncryKey)
	if err != nil {
		return encryptedRequestBlobPayload{}, nil, "", nil, err
	}
	ciphertext := aead.Seal(nil, payloadNonce, payload, requestAAD("payload", req.OracleSetID, -1))

	blobPayload := encryptedRequestBlobPayload{
		Version:     encryptedRequestVersion,
		OracleSetID: req.OracleSetID,
		Algorithm:   "X25519-HKDF-SHA256+ChaCha20Poly1305",
		Nonce:       hex.EncodeToString(payloadNonce),
		Deadline:    req.Deadline,
		Ciphertext:  hex.EncodeToString(ciphertext),
	}
	keyEnvelopes := make([]encryptedRequestKeyEnvelope, 0, len(recipients))
	for _, recipient := range recipients {
		wrapped, err := wrapAEncryKey(req.OracleSetID, recipient.OracleID, recipient.OEncryKey, aEncryKey)
		if err != nil {
			return encryptedRequestBlobPayload{}, nil, "", nil, err
		}
		keyEnvelopes = append(keyEnvelopes, wrapped)
	}
	canonical, requestID, err := canonicalEncryptedEnvelope(blobPayload, keyEnvelopes)
	if err != nil {
		return encryptedRequestBlobPayload{}, nil, "", nil, err
	}
	return blobPayload, keyEnvelopes, requestID, canonical, nil
}

func decryptCAVSRequest(blobPayload encryptedRequestBlobPayload, keyEnvelopes []encryptedRequestKeyEnvelope, oracleID int, oraclePrivateKey [32]byte, expectedOracleSetID string, now time.Time) (encryptedCAVSRequest, error) {
	if strings.TrimSpace(expectedOracleSetID) != "" && blobPayload.OracleSetID != strings.TrimSpace(expectedOracleSetID) {
		return encryptedCAVSRequest{}, fmt.Errorf("oracleSetID mismatch")
	}
	if blobPayload.Deadline > 0 && now.Unix() > blobPayload.Deadline {
		return encryptedCAVSRequest{}, fmt.Errorf("request expired")
	}
	var selected *encryptedRequestKeyEnvelope
	for i := range keyEnvelopes {
		if keyEnvelopes[i].OracleID == oracleID {
			selected = &keyEnvelopes[i]
			break
		}
	}
	if selected == nil {
		return encryptedCAVSRequest{}, fmt.Errorf("no key envelope for oracle %d", oracleID)
	}
	aEncryKey, err := unwrapAEncryKey(blobPayload.OracleSetID, oraclePrivateKey, *selected)
	if err != nil {
		return encryptedCAVSRequest{}, err
	}
	payloadNonce, err := hex.DecodeString(blobPayload.Nonce)
	if err != nil {
		return encryptedCAVSRequest{}, fmt.Errorf("decode payload nonce: %w", err)
	}
	ciphertext, err := hex.DecodeString(blobPayload.Ciphertext)
	if err != nil {
		return encryptedCAVSRequest{}, fmt.Errorf("decode ciphertext: %w", err)
	}
	aead, err := chacha20poly1305.New(aEncryKey)
	if err != nil {
		return encryptedCAVSRequest{}, err
	}
	payload, err := aead.Open(nil, payloadNonce, ciphertext, requestAAD("payload", blobPayload.OracleSetID, -1))
	if err != nil {
		return encryptedCAVSRequest{}, fmt.Errorf("decrypt request payload: %w", err)
	}
	var req encryptedCAVSRequest
	if err := json.Unmarshal(payload, &req); err != nil {
		return encryptedCAVSRequest{}, err
	}
	if req.OracleSetID != blobPayload.OracleSetID {
		return encryptedCAVSRequest{}, fmt.Errorf("decrypted oracleSetID mismatch")
	}
	if req.Deadline > 0 && now.Unix() > req.Deadline {
		return encryptedCAVSRequest{}, fmt.Errorf("request expired")
	}
	return req, nil
}

func canonicalEncryptedEnvelope(blobPayload encryptedRequestBlobPayload, keyEnvelopes []encryptedRequestKeyEnvelope) ([]byte, string, error) {
	env := encryptedRequestEnvelope{
		Version:      encryptedRequestVersion,
		OracleSetID:  blobPayload.OracleSetID,
		Algorithm:    blobPayload.Algorithm,
		Deadline:     blobPayload.Deadline,
		BlobPayload:  blobPayload,
		KeyEnvelopes: keyEnvelopes,
	}
	b, err := json.Marshal(env)
	if err != nil {
		return nil, "", err
	}
	return b, crypto.Keccak256Hash(b).Hex(), nil
}

func wrapAEncryKey(oracleSetID string, oracleID int, oEncryKey [32]byte, aEncryKey []byte) (encryptedRequestKeyEnvelope, error) {
	var ephPriv [32]byte
	if _, err := io.ReadFull(rand.Reader, ephPriv[:]); err != nil {
		return encryptedRequestKeyEnvelope{}, err
	}
	ephPub, err := curve25519.X25519(ephPriv[:], curve25519.Basepoint)
	if err != nil {
		return encryptedRequestKeyEnvelope{}, err
	}
	shared, err := curve25519.X25519(ephPriv[:], oEncryKey[:])
	if err != nil {
		return encryptedRequestKeyEnvelope{}, err
	}
	wrapKey, err := deriveRequestWrapKey(shared, oracleSetID, oracleID)
	if err != nil {
		return encryptedRequestKeyEnvelope{}, err
	}
	nonce := make([]byte, chacha20poly1305.NonceSize)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return encryptedRequestKeyEnvelope{}, err
	}
	aead, err := chacha20poly1305.New(wrapKey)
	if err != nil {
		return encryptedRequestKeyEnvelope{}, err
	}
	wrapped := aead.Seal(nil, nonce, aEncryKey, requestAAD("key", oracleSetID, oracleID))
	return encryptedRequestKeyEnvelope{
		OracleID:           oracleID,
		EphemeralPublicKey: hex.EncodeToString(ephPub),
		Nonce:              hex.EncodeToString(nonce),
		WrappedKey:         hex.EncodeToString(wrapped),
	}, nil
}

func unwrapAEncryKey(oracleSetID string, oraclePrivateKey [32]byte, envelope encryptedRequestKeyEnvelope) ([]byte, error) {
	ephPub, err := hex.DecodeString(envelope.EphemeralPublicKey)
	if err != nil || len(ephPub) != 32 {
		return nil, fmt.Errorf("malformed key envelope public key")
	}
	nonce, err := hex.DecodeString(envelope.Nonce)
	if err != nil {
		return nil, fmt.Errorf("malformed key envelope nonce")
	}
	wrapped, err := hex.DecodeString(envelope.WrappedKey)
	if err != nil {
		return nil, fmt.Errorf("malformed wrapped key")
	}
	shared, err := curve25519.X25519(oraclePrivateKey[:], ephPub)
	if err != nil {
		return nil, err
	}
	wrapKey, err := deriveRequestWrapKey(shared, oracleSetID, envelope.OracleID)
	if err != nil {
		return nil, err
	}
	aead, err := chacha20poly1305.New(wrapKey)
	if err != nil {
		return nil, err
	}
	key, err := aead.Open(nil, nonce, wrapped, requestAAD("key", oracleSetID, envelope.OracleID))
	if err != nil {
		return nil, fmt.Errorf("unwrap AEncryKey: %w", err)
	}
	return key, nil
}

func deriveRequestWrapKey(shared []byte, oracleSetID string, oracleID int) ([]byte, error) {
	info := []byte("CAVS request key wrap v1|" + strings.TrimSpace(oracleSetID) + "|" + strconv.Itoa(oracleID))
	reader := hkdf.New(sha256.New, shared, nil, info)
	out := make([]byte, chacha20poly1305.KeySize)
	_, err := io.ReadFull(reader, out)
	return out, err
}

func requestAAD(kind string, oracleSetID string, oracleID int) []byte {
	return []byte("CAVS encrypted request|" + kind + "|" + strings.TrimSpace(oracleSetID) + "|" + strconv.Itoa(oracleID))
}
