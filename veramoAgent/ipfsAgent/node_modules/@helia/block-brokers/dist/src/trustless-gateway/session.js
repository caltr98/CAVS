import { AbstractSession } from '@helia/utils';
import { findHttpGatewayProviders } from './utils.js';
import { DEFAULT_ALLOW_INSECURE, DEFAULT_ALLOW_LOCAL } from './index.js';
class TrustlessGatewaySession extends AbstractSession {
    routing;
    allowInsecure;
    allowLocal;
    constructor(components, init) {
        super(components, {
            ...init,
            name: 'helia:trustless-gateway:session'
        });
        this.routing = components.routing;
        this.allowInsecure = init.allowInsecure ?? DEFAULT_ALLOW_INSECURE;
        this.allowLocal = init.allowLocal ?? DEFAULT_ALLOW_LOCAL;
    }
    async queryProvider(cid, provider, options) {
        this.log('fetching BLOCK for %c from %s', cid, provider.url);
        const block = await provider.getRawBlock(cid, options.signal);
        this.log.trace('got block for %c from %s', cid, provider.url);
        await options.validateFn?.(block);
        return block;
    }
    async *findNewProviders(cid, options = {}) {
        yield* findHttpGatewayProviders(cid, this.routing, this.logger, this.allowInsecure, this.allowLocal, options);
    }
    toEvictionKey(provider) {
        return provider.url.toString();
    }
    equals(providerA, providerB) {
        return providerA.url.toString() === providerB.url.toString();
    }
}
export function createTrustlessGatewaySession(components, init) {
    return new TrustlessGatewaySession(components, init);
}
//# sourceMappingURL=session.js.map