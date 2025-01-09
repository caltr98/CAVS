import { type ProgressEvent } from 'progress-events';
import type { GetOptions, PutOptions } from './index.js';
import type { IPNSRouting } from '../index.js';
import type { Routing } from '@helia/interface';
export interface HeliaRoutingComponents {
    routing: Routing;
}
export type HeliaRoutingProgressEvents = ProgressEvent<'ipns:routing:helia:error', Error>;
export declare class HeliaRouting implements IPNSRouting {
    private readonly routing;
    constructor(routing: Routing);
    put(routingKey: Uint8Array, marshaledRecord: Uint8Array, options?: PutOptions): Promise<void>;
    get(routingKey: Uint8Array, options?: GetOptions): Promise<Uint8Array>;
}
/**
 * The helia routing uses any available Routers configured on the passed Helia
 * node. This could be libp2p, HTTP API Delegated Routing, etc.
 */
export declare function helia(routing: Routing): IPNSRouting;
//# sourceMappingURL=helia.d.ts.map