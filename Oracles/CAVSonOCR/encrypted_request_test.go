package main

import (
	"strings"
	"testing"
	"time"
)

func testRecipient(t *testing.T, oracleID int) (*offchainKeyring, requestRecipient) {
	t.Helper()
	kr, err := newOffchainKeyringGeneration(int64(1000+oracleID), oracleID)
	if err != nil {
		t.Fatal(err)
	}
	return kr, requestRecipient{OracleID: oracleID, OEncryKey: kr.OraclesEncryptionKey()}
}

func testEncryptedRequest(deadline int64) encryptedCAVSRequest {
	return newEncryptedCAVSRequest(
		"set-1",
		"http://cavs0:4200/ocr/author_oracle_request/callback/test-session",
		"did:ethr:sepolia:0x123",
		"Alice can assess this statement",
		"",
		[]byte(`{"holder":"did:ethr:sepolia:0x123","verifiableCredential":[]}`),
		"nonce-1",
		deadline,
	)
}

func TestEncryptedRequestDecryptsForRecipients(t *testing.T) {
	kr0, r0 := testRecipient(t, 0)
	kr1, r1 := testRecipient(t, 1)
	req := testEncryptedRequest(time.Now().Add(time.Hour).Unix())

	blobPayload, keyEnvelopes, requestID, canonical, err := encryptCAVSRequest(req, []requestRecipient{r0, r1})
	if err != nil {
		t.Fatal(err)
	}
	if requestID == "" || len(canonical) == 0 {
		t.Fatalf("missing request commitment")
	}
	if len(keyEnvelopes) != 2 {
		t.Fatalf("expected two key wraps, got %d", len(keyEnvelopes))
	}

	got0, err := decryptCAVSRequest(blobPayload, keyEnvelopes, 0, kr0.OraclesEncryptionPrivateKey(), "set-1", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	got1, err := decryptCAVSRequest(blobPayload, keyEnvelopes, 1, kr1.OraclesEncryptionPrivateKey(), "set-1", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if got0.Statement != req.Statement || got1.Statement != req.Statement {
		t.Fatalf("recipient decrypted wrong statement")
	}
	if got0.StatementHash == "" || got0.StatementHash != got1.StatementHash {
		t.Fatalf("statement hash was not preserved")
	}
}

func TestEncryptedRequestRejectsNonRecipient(t *testing.T) {
	_, recipient := testRecipient(t, 0)
	nonRecipient, _ := testRecipient(t, 2)
	req := testEncryptedRequest(time.Now().Add(time.Hour).Unix())

	blobPayload, keyEnvelopes, _, _, err := encryptCAVSRequest(req, []requestRecipient{recipient})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decryptCAVSRequest(blobPayload, keyEnvelopes, 2, nonRecipient.OraclesEncryptionPrivateKey(), "set-1", time.Now()); err == nil {
		t.Fatalf("non-recipient decrypted request")
	}
}

func TestEncryptedRequestIDChangesWhenPayloadChanges(t *testing.T) {
	_, recipient := testRecipient(t, 0)
	reqA := testEncryptedRequest(time.Now().Add(time.Hour).Unix())
	reqB := reqA
	reqB.Statement = reqB.Statement + " changed"
	reqB.StatementHash = statementHashHex(reqB.Statement)

	_, _, requestIDA, _, err := encryptCAVSRequest(reqA, []requestRecipient{recipient})
	if err != nil {
		t.Fatal(err)
	}
	_, _, requestIDB, _, err := encryptCAVSRequest(reqB, []requestRecipient{recipient})
	if err != nil {
		t.Fatal(err)
	}
	if requestIDA == requestIDB {
		t.Fatalf("requestID did not change")
	}
}

func TestEncryptedRequestRejectsExpiredAndWrongOracleSet(t *testing.T) {
	kr, recipient := testRecipient(t, 0)
	req := testEncryptedRequest(time.Now().Add(-time.Hour).Unix())

	blobPayload, keyEnvelopes, _, _, err := encryptCAVSRequest(req, []requestRecipient{recipient})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decryptCAVSRequest(blobPayload, keyEnvelopes, 0, kr.OraclesEncryptionPrivateKey(), "set-1", time.Now()); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("expected expired error, got %v", err)
	}

	req = testEncryptedRequest(time.Now().Add(time.Hour).Unix())
	blobPayload, keyEnvelopes, _, _, err = encryptCAVSRequest(req, []requestRecipient{recipient})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decryptCAVSRequest(blobPayload, keyEnvelopes, 0, kr.OraclesEncryptionPrivateKey(), "set-2", time.Now()); err == nil || !strings.Contains(err.Error(), "oracleSetID") {
		t.Fatalf("expected oracleSetID error, got %v", err)
	}
}

func TestEncryptedRequestRejectsMalformedEnvelope(t *testing.T) {
	kr, recipient := testRecipient(t, 0)
	req := testEncryptedRequest(time.Now().Add(time.Hour).Unix())
	blobPayload, keyEnvelopes, _, _, err := encryptCAVSRequest(req, []requestRecipient{recipient})
	if err != nil {
		t.Fatal(err)
	}
	keyEnvelopes[0].EphemeralPublicKey = "abcd"
	if _, err := decryptCAVSRequest(blobPayload, keyEnvelopes, 0, kr.OraclesEncryptionPrivateKey(), "set-1", time.Now()); err == nil {
		t.Fatalf("malformed key envelope decrypted")
	}
}
