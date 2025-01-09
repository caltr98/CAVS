import { AbstractSession } from '@helia/utils';
import type { BitswapWantProgressEvents } from './index.js';
import type { Network } from './network.js';
import type { WantList } from './want-list.js';
import type { CreateSessionOptions } from '@helia/interface';
import type { ComponentLogger, PeerId } from '@libp2p/interface';
import type { AbortOptions } from 'interface-store';
import type { CID } from 'multiformats/cid';
export interface BitswapSessionComponents {
    network: Network;
    wantList: WantList;
    logger: ComponentLogger;
}
declare class BitswapSession extends AbstractSession<PeerId, BitswapWantProgressEvents> {
    private readonly wantList;
    private readonly network;
    constructor(components: BitswapSessionComponents, init: CreateSessionOptions);
    queryProvider(cid: CID, provider: PeerId, options: AbortOptions): Promise<Uint8Array>;
    findNewProviders(cid: CID, options?: AbortOptions): AsyncGenerator<PeerId>;
    toEvictionKey(provider: PeerId): Uint8Array | string;
    equals(providerA: PeerId, providerB: PeerId): boolean;
}
export declare function createBitswapSession(components: BitswapSessionComponents, init: CreateSessionOptions): BitswapSession;
export {};
//# sourceMappingURL=session.d.ts.map