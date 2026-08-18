import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ExtractIdempotencyStore,
    IdempotencyCapacityError,
    IdempotencyConflictError,
    extractPayloadFingerprint,
} from './extractIdempotency.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

test('concurrent duplicate extract requests execute the model exactly once', async () => {
    const gate = deferred();
    const store = new ExtractIdempotencyStore();
    const payload = {
        text: 'distributed systems',
        requestId: 'request-1',
        authorSkills: ['consensus'],
    };
    let executions = 0;
    const operation = async () => {
        executions += 1;
        return await gate.promise;
    };

    const first = store.execute({ key: 'key-concurrent', payload, operation });
    const duplicate = store.execute({ key: 'key-concurrent', payload, operation });
    await Promise.resolve();

    assert.equal(executions, 1);
    assert.equal(store.inFlightSize, 1);

    const modelResult = { status: 200, body: { competent: true, confidence: 0.9 } };
    gate.resolve(modelResult);
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);

    assert.equal(firstResult.disposition, 'created');
    assert.equal(duplicateResult.disposition, 'in-flight');
    assert.deepEqual(firstResult.value, modelResult);
    assert.deepEqual(duplicateResult.value, modelResult);
    assert.equal(store.inFlightSize, 0);
    assert.equal(store.resultSize, 1);
});

test('completed duplicate replays the cached result without key-order sensitivity', async () => {
    const store = new ExtractIdempotencyStore();
    let executions = 0;

    const first = await store.execute({
        key: 'key-replay',
        payload: { text: 'same', options: { mode: 'gpt', seed: 7 } },
        operation: async () => {
            executions += 1;
            return { status: 200, body: { execution: executions } };
        },
    });
    const replay = await store.execute({
        key: 'key-replay',
        payload: { options: { seed: 7, mode: 'gpt' }, text: 'same' },
        operation: async () => {
            executions += 1;
            return { status: 200, body: { execution: executions } };
        },
    });

    assert.equal(first.disposition, 'created');
    assert.equal(replay.disposition, 'replayed');
    assert.equal(executions, 1);
    assert.deepEqual(replay.value, first.value);
    assert.equal(
        extractPayloadFingerprint({ a: 1, b: 2 }),
        extractPayloadFingerprint({ b: 2, a: 1 }),
    );
});

test('reusing a key with a different payload conflicts for cached and in-flight work', async () => {
    const cachedStore = new ExtractIdempotencyStore();
    await cachedStore.execute({
        key: 'key-conflict-cached',
        payload: { text: 'first payload' },
        operation: async () => ({ status: 200, body: { ok: true } }),
    });

    let conflictingExecutions = 0;
    await assert.rejects(
        cachedStore.execute({
            key: 'key-conflict-cached',
            payload: { text: 'different payload' },
            operation: async () => {
                conflictingExecutions += 1;
                return { status: 200, body: { ok: false } };
            },
        }),
        IdempotencyConflictError,
    );
    assert.equal(conflictingExecutions, 0);

    const inFlightStore = new ExtractIdempotencyStore();
    const gate = deferred();
    const active = inFlightStore.execute({
        key: 'key-conflict-active',
        payload: { text: 'first payload' },
        operation: async () => await gate.promise,
    });
    await assert.rejects(
        inFlightStore.execute({
            key: 'key-conflict-active',
            payload: { text: 'different payload' },
            operation: async () => ({ status: 200, body: { ok: false } }),
        }),
        IdempotencyConflictError,
    );
    gate.resolve({ status: 200, body: { ok: true } });
    await active;
});

test('result eviction and in-flight admission remain strictly bounded', async () => {
    const store = new ExtractIdempotencyStore({
        maxInFlight: 1,
        maxResults: 2,
        resultTtlMs: 60_000,
    });
    let executions = 0;
    const execute = (key) => store.execute({
        key,
        payload: { text: key },
        operation: async () => {
            executions += 1;
            return { status: 200, body: { key, executions } };
        },
    });

    await execute('key-1');
    await execute('key-2');
    // Touch key-1 so key-2 is the least-recently-used result.
    assert.equal((await execute('key-1')).disposition, 'replayed');
    await execute('key-3');
    assert.equal(store.resultSize, 2);

    assert.equal((await execute('key-2')).disposition, 'created');
    assert.equal(executions, 4);
    assert.equal(store.resultSize, 2);

    const activeStore = new ExtractIdempotencyStore({ maxInFlight: 1 });
    const gate = deferred();
    const active = activeStore.execute({
        key: 'active-1',
        payload: { text: 'active-1' },
        operation: async () => await gate.promise,
    });
    await assert.rejects(
        activeStore.execute({
            key: 'active-2',
            payload: { text: 'active-2' },
            operation: async () => ({ status: 200, body: { ok: true } }),
        }),
        IdempotencyCapacityError,
    );
    assert.equal(activeStore.inFlightSize, 1);
    gate.resolve({ status: 200, body: { ok: true } });
    await active;
});

test('thrown and non-success results are not cached', async () => {
    let thrownExecutions = 0;
    const thrownStore = new ExtractIdempotencyStore();
    await assert.rejects(
        thrownStore.execute({
            key: 'key-thrown',
            payload: { text: 'retry me' },
            operation: async () => {
                thrownExecutions += 1;
                throw new Error('provider connection failed');
            },
        }),
        /provider connection failed/,
    );
    assert.equal(thrownStore.resultSize, 0);

    const recovered = await thrownStore.execute({
        key: 'key-thrown',
        payload: { text: 'retry me' },
        operation: async () => {
            thrownExecutions += 1;
            return { status: 200, body: { recovered: true } };
        },
    });
    assert.equal(recovered.disposition, 'created');
    assert.equal(thrownExecutions, 2);

    let statusExecutions = 0;
    const statusStore = new ExtractIdempotencyStore({
        isCacheable: (result) => result.status >= 200 && result.status < 300,
    });
    await statusStore.execute({
        key: 'key-502',
        payload: { text: 'provider timeout' },
        operation: async () => {
            statusExecutions += 1;
            return { status: 502, body: { error: 'provider timeout' } };
        },
    });
    assert.equal(statusStore.resultSize, 0);

    await statusStore.execute({
        key: 'key-502',
        payload: { text: 'provider timeout' },
        operation: async () => {
            statusExecutions += 1;
            return { status: 200, body: { recovered: true } };
        },
    });
    assert.equal(statusExecutions, 2);
    assert.equal(statusStore.resultSize, 1);
});

test('requests without Idempotency-Key preserve normal execution behavior', async () => {
    const store = new ExtractIdempotencyStore();
    let executions = 0;
    const run = () => store.execute({
        key: undefined,
        payload: { text: 'headerless request' },
        operation: async () => {
            executions += 1;
            return { status: 200, body: { executions } };
        },
    });

    assert.equal((await run()).disposition, 'bypass');
    assert.equal((await run()).disposition, 'bypass');
    assert.equal(executions, 2);
    assert.equal(store.resultSize, 0);
});
