import { type Datastore } from 'interface-datastore';
import { type ProgressEvent } from 'progress-events';
import type { GetOptions, PutOptions } from '../routing';
import type { AbortOptions } from '@libp2p/interface';
export type DatastoreProgressEvents = ProgressEvent<'ipns:routing:datastore:put'> | ProgressEvent<'ipns:routing:datastore:get'> | ProgressEvent<'ipns:routing:datastore:error', Error>;
export interface GetResult {
    record: Uint8Array;
    created: Date;
}
export interface LocalStore {
    put(routingKey: Uint8Array, marshaledRecord: Uint8Array, options?: PutOptions): Promise<void>;
    get(routingKey: Uint8Array, options?: GetOptions): Promise<GetResult>;
    has(routingKey: Uint8Array, options?: AbortOptions): Promise<boolean>;
    delete(routingKey: Uint8Array, options?: AbortOptions): Promise<void>;
}
/**
 * Returns an IPNSRouting implementation that reads/writes IPNS records to the
 * datastore as DHT records. This lets us publish IPNS records offline then
 * serve them to the network later in response to DHT queries.
 */
export declare function localStore(datastore: Datastore): LocalStore;
//# sourceMappingURL=local-store.d.ts.map