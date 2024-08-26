import { AbstractSession } from '@helia/utils';
import type { CreateTrustlessGatewaySessionOptions } from './broker.js';
import type { TrustlessGatewayGetBlockProgressEvents } from './index.js';
import type { TrustlessGateway } from './trustless-gateway.js';
import type { BlockRetrievalOptions, Routing } from '@helia/interface';
import type { ComponentLogger } from '@libp2p/interface';
import type { AbortOptions } from 'interface-store';
import type { CID } from 'multiformats/cid';
export interface TrustlessGatewaySessionComponents {
    logger: ComponentLogger;
    routing: Routing;
}
declare class TrustlessGatewaySession extends AbstractSession<TrustlessGateway, TrustlessGatewayGetBlockProgressEvents> {
    private readonly routing;
    private readonly allowInsecure;
    private readonly allowLocal;
    constructor(components: TrustlessGatewaySessionComponents, init: CreateTrustlessGatewaySessionOptions);
    queryProvider(cid: CID, provider: TrustlessGateway, options: BlockRetrievalOptions): Promise<Uint8Array>;
    findNewProviders(cid: CID, options?: AbortOptions): AsyncGenerator<TrustlessGateway>;
    toEvictionKey(provider: TrustlessGateway): Uint8Array | string;
    equals(providerA: TrustlessGateway, providerB: TrustlessGateway): boolean;
}
export declare function createTrustlessGatewaySession(components: TrustlessGatewaySessionComponents, init: CreateTrustlessGatewaySessionOptions): TrustlessGatewaySession;
export {};
//# sourceMappingURL=session.d.ts.map