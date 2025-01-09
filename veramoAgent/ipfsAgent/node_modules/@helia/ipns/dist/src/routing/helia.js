import { CustomProgressEvent } from 'progress-events';
export class HeliaRouting {
    routing;
    constructor(routing) {
        this.routing = routing;
    }
    async put(routingKey, marshaledRecord, options = {}) {
        try {
            await this.routing.put(routingKey, marshaledRecord, options);
        }
        catch (err) {
            options.onProgress?.(new CustomProgressEvent('ipns:routing:helia:error', err));
        }
    }
    async get(routingKey, options = {}) {
        try {
            return await this.routing.get(routingKey, options);
        }
        catch (err) {
            options.onProgress?.(new CustomProgressEvent('ipns:routing:helia:error', err));
        }
        throw new Error('Not found');
    }
}
/**
 * The helia routing uses any available Routers configured on the passed Helia
 * node. This could be libp2p, HTTP API Delegated Routing, etc.
 */
export function helia(routing) {
    return new HeliaRouting(routing);
}
//# sourceMappingURL=helia.js.map