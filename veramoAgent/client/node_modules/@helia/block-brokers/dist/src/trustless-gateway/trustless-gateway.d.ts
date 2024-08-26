import type { ComponentLogger } from '@libp2p/interface';
import type { CID } from 'multiformats/cid';
export interface TrustlessGatewayStats {
    attempts: number;
    errors: number;
    invalidBlocks: number;
    successes: number;
    pendingResponses?: number;
}
/**
 * A `TrustlessGateway` keeps track of the number of attempts, errors, and
 * successes for a given gateway url so that we can prioritize gateways that
 * have been more reliable in the past, and ensure that requests are distributed
 * across all gateways within a given `TrustlessGatewayBlockBroker` instance.
 */
export declare class TrustlessGateway {
    #private;
    readonly url: URL;
    private readonly log;
    constructor(url: URL | string, logger: ComponentLogger);
    /**
     * Fetch a raw block from `this.url` following the specification defined at
     * https://specs.ipfs.tech/http-gateways/trustless-gateway/
     */
    getRawBlock(cid: CID, signal?: AbortSignal): Promise<Uint8Array>;
    /**
     * Encapsulate the logic for determining whether a gateway is considered
     * reliable, for prioritization. This is based on the number of successful attempts made
     * and the number of errors encountered.
     *
     * Unused gateways have 100% reliability; They will be prioritized over
     * gateways with a 100% success rate to ensure that we attempt all gateways.
     */
    reliability(): number;
    /**
     * Increment the number of invalid blocks returned by this gateway.
     */
    incrementInvalidBlocks(): void;
    getStats(): TrustlessGatewayStats;
}
//# sourceMappingURL=trustless-gateway.d.ts.map