import type { Routing, BlockBroker } from '@helia/interface';
import type { ComponentLogger } from '@libp2p/interface';
import type { ProgressEvent } from 'progress-events';
export declare const DEFAULT_ALLOW_INSECURE = false;
export declare const DEFAULT_ALLOW_LOCAL = false;
export type TrustlessGatewayGetBlockProgressEvents = ProgressEvent<'trustless-gateway:get-block:fetch', URL>;
export interface TrustlessGatewayBlockBrokerInit {
    /**
     * By default we will only connect to peers with HTTPS addresses, pass true
     * to also connect to HTTP addresses.
     *
     * @default false
     */
    allowInsecure?: boolean;
    /**
     * By default we will only connect to peers with public or DNS addresses, pass
     * true to also connect to private addresses.
     *
     * @default false
     */
    allowLocal?: boolean;
}
export interface TrustlessGatewayBlockBrokerComponents {
    routing: Routing;
    logger: ComponentLogger;
}
export declare function trustlessGateway(init?: TrustlessGatewayBlockBrokerInit): (components: TrustlessGatewayBlockBrokerComponents) => BlockBroker<TrustlessGatewayGetBlockProgressEvents>;
//# sourceMappingURL=index.d.ts.map