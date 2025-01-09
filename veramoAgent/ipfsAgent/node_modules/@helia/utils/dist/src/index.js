/**
 * @packageDocumentation
 *
 * Exports a `Helia` class that implements the Helia API.
 *
 * In general you should use the `helia` or `@helia/http` modules instead which
 * pre-configure Helia for certain use-cases (p2p or pure-HTTP).
 *
 * @example
 *
 * ```typescript
 * import { Helia } from '@helia/utils'
 * import type { HeliaInit } from '@helia/utils'
 *
 * const node = new Helia({
 *   // ...options
 * } as HeliaInit)
 * ```
 */
import { contentRoutingSymbol, peerRoutingSymbol, start, stop } from '@libp2p/interface';
import { defaultLogger } from '@libp2p/logger';
import { dns } from '@multiformats/dns';
import drain from 'it-drain';
import { CustomProgressEvent } from 'progress-events';
import { PinsImpl } from './pins.js';
import { Routing as RoutingClass } from './routing.js';
import { BlockStorage } from './storage.js';
import { assertDatastoreVersionIsCurrent } from './utils/datastore-version.js';
import { getCodec } from './utils/get-codec.js';
import { getHasher } from './utils/get-hasher.js';
import { NetworkedStorage } from './utils/networked-storage.js';
export { AbstractSession } from './abstract-session.js';
export class Helia {
    blockstore;
    datastore;
    pins;
    logger;
    routing;
    getCodec;
    getHasher;
    dns;
    metrics;
    log;
    constructor(init) {
        this.logger = init.logger ?? defaultLogger();
        this.log = this.logger.forComponent('helia');
        this.getHasher = getHasher(init.hashers, init.loadHasher);
        this.getCodec = getCodec(init.codecs, init.loadCodec);
        this.dns = init.dns ?? dns();
        this.metrics = init.metrics;
        // @ts-expect-error routing is not set
        const components = {
            blockstore: init.blockstore,
            datastore: init.datastore,
            logger: this.logger,
            blockBrokers: [],
            getHasher: this.getHasher,
            getCodec: this.getCodec,
            dns: this.dns,
            metrics: this.metrics,
            ...(init.components ?? {})
        };
        this.routing = components.routing = new RoutingClass(components, {
            routers: (init.routers ?? []).flatMap((router) => {
                // if the router itself is a router
                const routers = [
                    router
                ];
                // if the router provides a libp2p-style ContentRouter
                if (router[contentRoutingSymbol] != null) {
                    routers.push(router[contentRoutingSymbol]);
                }
                // if the router provides a libp2p-style PeerRouter
                if (router[peerRoutingSymbol] != null) {
                    routers.push(router[peerRoutingSymbol]);
                }
                return routers;
            }),
            providerLookupConcurrency: init.providerLookupConcurrency
        });
        const networkedStorage = new NetworkedStorage(components);
        this.pins = new PinsImpl(init.datastore, networkedStorage, this.getCodec);
        this.blockstore = new BlockStorage(networkedStorage, this.pins, {
            holdGcLock: init.holdGcLock ?? true
        });
        this.datastore = init.datastore;
        components.blockBrokers = init.blockBrokers.map((fn) => {
            return fn(components);
        });
    }
    async start() {
        await assertDatastoreVersionIsCurrent(this.datastore);
        await start(this.blockstore, this.datastore, this.routing);
    }
    async stop() {
        await stop(this.blockstore, this.datastore, this.routing);
    }
    async gc(options = {}) {
        const releaseLock = await this.blockstore.lock.writeLock();
        try {
            const helia = this;
            const blockstore = this.blockstore.unwrap();
            this.log('gc start');
            await drain(blockstore.deleteMany((async function* () {
                for await (const { cid } of blockstore.getAll()) {
                    try {
                        if (await helia.pins.isPinned(cid, options)) {
                            continue;
                        }
                        yield cid;
                        options.onProgress?.(new CustomProgressEvent('helia:gc:deleted', cid));
                    }
                    catch (err) {
                        helia.log.error('Error during gc', err);
                        options.onProgress?.(new CustomProgressEvent('helia:gc:error', err));
                    }
                }
            }())));
        }
        finally {
            releaseLock();
        }
        this.log('gc finished');
    }
}
//# sourceMappingURL=index.js.map