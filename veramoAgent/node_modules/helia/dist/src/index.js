/**
 * @packageDocumentation
 *
 * Exports a `createHelia` function that returns an object that implements the {@link Helia} API.
 *
 * Pass it to other modules like {@link https://www.npmjs.com/package/@helia/unixfs | @helia/unixfs} to make files available on the distributed web.
 *
 * @example
 *
 * ```typescript
 * import { createHelia } from 'helia'
 * import { unixfs } from '@helia/unixfs'
 * import { CID } from 'multiformats/cid'
 *
 * const helia = await createHelia()
 *
 * const fs = unixfs(helia)
 * fs.cat(CID.parse('bafyFoo'))
 * ```
 */
import { bitswap, trustlessGateway } from '@helia/block-brokers';
import { httpGatewayRouting, libp2pRouting } from '@helia/routers';
import { MemoryBlockstore } from 'blockstore-core';
import { MemoryDatastore } from 'datastore-core';
import { HeliaP2P } from './helia-p2p.js';
import { libp2pDefaults } from './utils/libp2p-defaults.js';
import { createLibp2p } from './utils/libp2p.js';
// re-export interface types so people don't have to depend on @helia/interface
// if they don't want to
export * from '@helia/interface';
export { libp2pDefaults };
export async function createHelia(init = {}) {
    const datastore = init.datastore ?? new MemoryDatastore();
    const blockstore = init.blockstore ?? new MemoryBlockstore();
    let libp2p;
    if (isLibp2p(init.libp2p)) {
        libp2p = init.libp2p;
    }
    else {
        libp2p = await createLibp2p({
            ...init,
            libp2p: {
                dns: init.dns,
                ...init.libp2p,
                // ignore the libp2p start parameter as it should be on the main init
                // object instead
                start: undefined
            },
            datastore
        });
    }
    const helia = new HeliaP2P({
        ...init,
        libp2p,
        datastore,
        blockstore,
        blockBrokers: init.blockBrokers ?? [
            trustlessGateway(),
            bitswap()
        ],
        routers: init.routers ?? [
            libp2pRouting(libp2p),
            httpGatewayRouting()
        ],
        metrics: libp2p.metrics
    });
    if (init.start !== false) {
        await helia.start();
    }
    return helia;
}
function isLibp2p(obj) {
    if (obj == null) {
        return false;
    }
    // a non-exhaustive list of methods found on the libp2p object
    const funcs = ['dial', 'dialProtocol', 'hangUp', 'handle', 'unhandle', 'getMultiaddrs', 'getProtocols'];
    // if these are all functions it's probably a libp2p object
    return funcs.every(m => typeof obj[m] === 'function');
}
//# sourceMappingURL=index.js.map