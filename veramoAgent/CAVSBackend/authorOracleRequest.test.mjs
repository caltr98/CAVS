import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const temporaryRegistry = fs.mkdtempSync(path.join(os.tmpdir(), 'cavs-requester-test-'));
process.env.OCR_REGISTRY_DIR = temporaryRegistry;

const { refreshSessionStatus, trackBackgroundRequestSubmission } = await import(
    `./authorOracleRequest.js?requester-test=${Date.now()}`
);

function makeSession({ finalVc = null } = {}) {
    const now = new Date().toISOString();
    return {
        sessionId: `test-${Math.random().toString(36).slice(2)}`,
        status: 'submitting',
        createdAt: now,
        createdAtMs: Date.now(),
        updatedAt: now,
        updatedAtMs: Date.now(),
        logs: [],
        oracles: [],
        finalResult: finalVc ? { vc: finalVc } : null,
        finalVc,
        attestation: null,
        requestTxError: '',
        requestTxTrackingError: '',
        registryTxHash: '',
        requestBroadcastStartedAt: null,
        requestBroadcastAt: null,
        requestMinedAt: null,
    };
}

test.after(() => {
    fs.rmSync(temporaryRegistry, { recursive: true, force: true });
});

test('background submission failure is exposed through session status', async () => {
    const session = makeSession();
    await trackBackgroundRequestSubmission(
        session,
        Promise.reject(new Error('broadcast unavailable')),
    );

    assert.equal(session.status, 'failed');
    assert.match(session.requestTxError, /broadcast unavailable/);
    assert.equal(session.requestTxTrackingError, '');
    assert.ok(session.logs.some((line) => line.includes('failed in the background')));
});

test('late receipt-tracking failure cannot overwrite a completed result', async () => {
    const session = makeSession({ finalVc: { id: 'vc-1' } });
    await trackBackgroundRequestSubmission(
        session,
        Promise.reject(new Error('receipt poll unavailable')),
    );

    assert.equal(session.status, 'done');
    assert.equal(session.requestTxError, '');
    assert.match(session.requestTxTrackingError, /receipt poll unavailable/);
});

test('receipt tracking failure after broadcast is not a submission failure', async () => {
    const session = makeSession();
    session.registryTxHash = '0xabc';
    session.requestBroadcastAt = new Date().toISOString();

    await trackBackgroundRequestSubmission(
        session,
        Promise.reject(new Error('receipt poll unavailable')),
    );

    assert.equal(session.status, 'request_pending');
    assert.equal(session.requestTxError, '');
    assert.match(session.requestTxTrackingError, /receipt poll unavailable/);
});

test('a final VC wins a race with an earlier submission error', () => {
    const session = makeSession();
    session.requestTxError = 'earlier background failure';
    session.finalVc = { id: 'vc-after-error' };
    session.finalResult = { vc: session.finalVc };

    refreshSessionStatus(session);

    assert.equal(session.status, 'done');
    assert.ok(session.completedAt);
    const completedAt = session.completedAt;
    refreshSessionStatus(session);
    assert.equal(session.completedAt, completedAt);
});

test('/start schedules submission without awaiting its receipt', () => {
    const source = fs.readFileSync(
        new URL('./authorOracleRequest.js', import.meta.url),
        'utf8',
    );
    assert.match(source, /const queuedSubmission = enqueueRequestSubmission\(/);
    assert.doesNotMatch(source, /await enqueueRequestSubmission\(/);
    assert.match(source, /res\.status\(202\)\.json\(publicSession\(session\)\)/);
    assert.match(source, /provider\.pollingInterval = AUTHOR_RPC_POLL_INTERVAL_MS/);
    assert.match(source, /AUTHOR_TX_RECEIPT_TIMEOUT_MS/);
    assert.match(source, /session\.requestBlockTimestamp = new Date/);
    assert.match(source, /session\.requestBroadcastStartedAt = nowIso\(\)/);
    assert.doesNotMatch(
        source,
        /session\.requestMinedAt = new Date\(Number\(minedBlock\.timestamp\)/,
    );
    assert.match(source, /registeredOracleIds\.map\(async \(oracleId\)/);
    assert.match(source, /await closeProvider\(submissionProvider\)/);
    assert.match(source, /fs\.renameSync\(temporary, filePath\)/);
    assert.match(source, /safeOracleRequestCallback/);
    assert.match(source, /could not read oracle request session/);
});

test('the blob cache is committed before an automined request can wake oracles', () => {
    const source = fs.readFileSync(
        new URL('./authorOracleRequest.js', import.meta.url),
        'utf8',
    );
    const submission = source.split(
        'const queuedSubmission = enqueueRequestSubmission(',
        2,
    )[1];
    assert.ok(submission, 'queued submission source is present');
    const cache = submission.indexOf(
        'cacheBlobPayload(artifacts.requestID, artifacts.blobPayload);',
    );
    const broadcast = submission.indexOf(
        "withRpcRetry('broadcastTransaction'",
    );
    assert.ok(cache >= 0, 'blob payload is cached');
    assert.ok(broadcast >= 0, 'transaction is broadcast');
    assert.ok(cache < broadcast, 'cache commit precedes the first broadcast attempt');
});
