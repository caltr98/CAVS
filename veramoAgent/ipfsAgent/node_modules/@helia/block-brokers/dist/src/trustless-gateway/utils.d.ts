import { TrustlessGateway } from './trustless-gateway.js';
import type { Routing } from '@helia/interface';
import type { ComponentLogger } from '@libp2p/interface';
import type { AbortOptions, Multiaddr } from '@multiformats/multiaddr';
import type { CID } from 'multiformats/cid';
export declare function filterNonHTTPMultiaddrs(multiaddrs: Multiaddr[], allowInsecure: boolean, allowLocal: boolean): Multiaddr[];
export declare function findHttpGatewayProviders(cid: CID, routing: Routing, logger: ComponentLogger, allowInsecure: boolean, allowLocal: boolean, options?: AbortOptions): AsyncGenerator<TrustlessGateway>;
//# sourceMappingURL=utils.d.ts.map