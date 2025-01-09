import { type ProgressEvent } from 'progress-events';
import type { IPNSRouting } from './index.js';
import type { PeerId, PublishResult, PubSub } from '@libp2p/interface';
import type { Datastore } from 'interface-datastore';
export interface PubsubRoutingComponents {
    datastore: Datastore;
    libp2p: {
        peerId: PeerId;
        services: {
            pubsub: PubSub;
        };
    };
}
export type PubSubProgressEvents = ProgressEvent<'ipns:pubsub:publish', {
    topic: string;
    result: PublishResult;
}> | ProgressEvent<'ipns:pubsub:subscribe', {
    topic: string;
}> | ProgressEvent<'ipns:pubsub:error', Error>;
/**
 * This IPNS routing receives IPNS record updates via dedicated
 * pubsub topic.
 *
 * Note we must first be subscribed to the topic in order to receive
 * updated records, so the first call to `.get` should be expected
 * to fail!
 */
export declare function pubsub(components: PubsubRoutingComponents): IPNSRouting;
//# sourceMappingURL=pubsub.d.ts.map