import { createHash } from 'node:crypto';

const DEFAULT_MAX_KEY_BYTES = 256;

export class InvalidIdempotencyKeyError extends Error {
    constructor(message = 'invalid Idempotency-Key') {
        super(message);
        this.name = 'InvalidIdempotencyKeyError';
        this.code = 'INVALID_IDEMPOTENCY_KEY';
        this.statusCode = 400;
    }
}

export class IdempotencyConflictError extends Error {
    constructor() {
        super('Idempotency-Key was already used with a different request payload');
        this.name = 'IdempotencyConflictError';
        this.code = 'IDEMPOTENCY_KEY_PAYLOAD_CONFLICT';
        this.statusCode = 409;
    }
}

export class IdempotencyCapacityError extends Error {
    constructor() {
        super('idempotent request capacity is temporarily exhausted');
        this.name = 'IdempotencyCapacityError';
        this.code = 'IDEMPOTENCY_CAPACITY_EXHAUSTED';
        this.statusCode = 503;
    }
}

export function normalizeIdempotencyKey(value, maxKeyBytes = DEFAULT_MAX_KEY_BYTES) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    if (typeof value !== 'string') {
        throw new InvalidIdempotencyKeyError();
    }

    const key = value.trim();
    if (
        key.length === 0
        || Buffer.byteLength(key, 'utf8') > maxKeyBytes
        || !/^[\x21-\x7e]+$/.test(key)
    ) {
        throw new InvalidIdempotencyKeyError();
    }
    return key;
}

function canonicalizeJson(value, ancestors = new Set()) {
    if (value === null) return 'null';

    switch (typeof value) {
        case 'string':
        case 'boolean':
            return JSON.stringify(value);
        case 'number':
            if (!Number.isFinite(value)) {
                throw new TypeError('idempotent request payload contains a non-finite number');
            }
            return JSON.stringify(value);
        case 'object': {
            if (ancestors.has(value)) {
                throw new TypeError('idempotent request payload must not be cyclic');
            }
            ancestors.add(value);
            try {
                if (Array.isArray(value)) {
                    return `[${value.map((item) => canonicalizeJson(item, ancestors)).join(',')}]`;
                }
                const fields = Object.keys(value)
                    .sort()
                    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key], ancestors)}`);
                return `{${fields.join(',')}}`;
            } finally {
                ancestors.delete(value);
            }
        }
        default:
            throw new TypeError(`unsupported JSON payload value: ${typeof value}`);
    }
}

// The client-supplied key identifies the logical operation. This independent
// canonical payload fingerprint binds that key to the exact JSON request while
// it is in flight or retained in the result cache. It also avoids treating
// harmless object-key ordering differences as conflicting payloads.
export function extractPayloadFingerprint(payload) {
    return createHash('sha256')
        .update('cavs-extract-payload-v1\n', 'utf8')
        .update(canonicalizeJson(payload), 'utf8')
        .digest('hex');
}

export class ExtractIdempotencyStore {
    #inFlight = new Map();
    #results = new Map();
    #maxInFlight;
    #maxResults;
    #resultTtlMs;
    #now;
    #isCacheable;

    constructor({
        maxInFlight = 256,
        maxResults = 512,
        resultTtlMs = 15 * 60 * 1000,
        now = Date.now,
        isCacheable = () => true,
    } = {}) {
        if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
            throw new TypeError('maxInFlight must be a positive integer');
        }
        if (!Number.isInteger(maxResults) || maxResults < 1) {
            throw new TypeError('maxResults must be a positive integer');
        }
        if (!Number.isFinite(resultTtlMs) || resultTtlMs < 1) {
            throw new TypeError('resultTtlMs must be positive');
        }
        if (typeof now !== 'function' || typeof isCacheable !== 'function') {
            throw new TypeError('now and isCacheable must be functions');
        }

        this.#maxInFlight = maxInFlight;
        this.#maxResults = maxResults;
        this.#resultTtlMs = resultTtlMs;
        this.#now = now;
        this.#isCacheable = isCacheable;
    }

    get inFlightSize() {
        return this.#inFlight.size;
    }

    get resultSize() {
        this.#pruneExpiredResults();
        return this.#results.size;
    }

    async execute({ key: rawKey, payload, operation }) {
        if (typeof operation !== 'function') {
            throw new TypeError('operation must be a function');
        }

        const key = normalizeIdempotencyKey(rawKey);
        if (key === null) {
            return {
                disposition: 'bypass',
                value: await operation(),
            };
        }

        const fingerprint = extractPayloadFingerprint(payload);
        this.#pruneExpiredResults();

        const cached = this.#results.get(key);
        if (cached) {
            this.#assertSamePayload(cached.fingerprint, fingerprint);
            // Map insertion order implements a bounded LRU cache.
            this.#results.delete(key);
            this.#results.set(key, cached);
            return {
                disposition: 'replayed',
                value: cached.value,
            };
        }

        const active = this.#inFlight.get(key);
        if (active) {
            this.#assertSamePayload(active.fingerprint, fingerprint);
            return {
                disposition: 'in-flight',
                value: await active.promise,
            };
        }

        if (this.#inFlight.size >= this.#maxInFlight) {
            // Executing without tracking would defeat deduplication exactly
            // when the service is under the most pressure.
            throw new IdempotencyCapacityError();
        }

        // Defer operation invocation to a microtask so the in-flight entry is
        // visible before any user code begins executing.
        const promise = Promise.resolve().then(operation);
        const entry = { fingerprint, promise };
        this.#inFlight.set(key, entry);

        try {
            const value = await promise;
            if (this.#isCacheable(value)) {
                this.#storeResult(key, fingerprint, value);
            }
            return {
                disposition: 'created',
                value,
            };
        } finally {
            if (this.#inFlight.get(key) === entry) {
                this.#inFlight.delete(key);
            }
        }
    }

    #assertSamePayload(existingFingerprint, fingerprint) {
        if (existingFingerprint !== fingerprint) {
            throw new IdempotencyConflictError();
        }
    }

    #pruneExpiredResults() {
        const now = this.#now();
        for (const [key, entry] of this.#results) {
            if (entry.expiresAt <= now) {
                this.#results.delete(key);
            }
        }
    }

    #storeResult(key, fingerprint, value) {
        this.#results.delete(key);
        while (this.#results.size >= this.#maxResults) {
            const oldestKey = this.#results.keys().next().value;
            this.#results.delete(oldestKey);
        }
        this.#results.set(key, {
            fingerprint,
            value,
            expiresAt: this.#now() + this.#resultTtlMs,
        });
    }
}
