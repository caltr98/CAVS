import { TypedEventEmitter } from '@libp2p/interface';
import type { BlockBroker, BlockRetrievalOptions, CreateSessionOptions } from '@helia/interface';
import type { AbortOptions, ComponentLogger, Logger } from '@libp2p/interface';
import type { CID } from 'multiformats/cid';
import type { ProgressEvent } from 'progress-events';
export interface AbstractSessionComponents {
    logger: ComponentLogger;
}
export interface AbstractCreateSessionOptions extends CreateSessionOptions {
    name: string;
}
export interface BlockstoreSessionEvents<Provider> {
    provider: CustomEvent<Provider>;
}
export declare abstract class AbstractSession<Provider, RetrieveBlockProgressEvents extends ProgressEvent> extends TypedEventEmitter<BlockstoreSessionEvents<Provider>> implements BlockBroker<RetrieveBlockProgressEvents> {
    private intialPeerSearchComplete?;
    private readonly requests;
    private readonly name;
    protected log: Logger;
    protected logger: ComponentLogger;
    private readonly minProviders;
    private readonly maxProviders;
    readonly providers: Provider[];
    private readonly evictionFilter;
    constructor(components: AbstractSessionComponents, init: AbstractCreateSessionOptions);
    retrieve(cid: CID, options?: BlockRetrievalOptions<RetrieveBlockProgressEvents>): Promise<Uint8Array>;
    evict(provider: Provider): void;
    isEvicted(provider: Provider): boolean;
    hasProvider(provider: Provider): boolean;
    private findProviders;
    /**
     * This method should search for new providers and yield them.
     */
    abstract findNewProviders(cid: CID, options: AbortOptions): AsyncGenerator<Provider>;
    /**
     * The subclass should contact the provider and request the block from it.
     *
     * If the provider cannot provide the block an error should be thrown.
     *
     * The provider will then be excluded from ongoing queries.
     */
    abstract queryProvider(cid: CID, provider: Provider, options: AbortOptions): Promise<Uint8Array>;
    /**
     * Turn a provider into a concise Uint8Array representation for use in a Bloom
     * filter
     */
    abstract toEvictionKey(provider: Provider): Uint8Array | string;
    /**
     * Return `true` if we consider one provider to be the same as another
     */
    abstract equals(providerA: Provider, providerB: Provider): boolean;
}
//# sourceMappingURL=abstract-session.d.ts.map