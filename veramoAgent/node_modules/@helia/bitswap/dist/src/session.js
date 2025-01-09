import { AbstractSession } from '@helia/utils';
class BitswapSession extends AbstractSession {
    wantList;
    network;
    constructor(components, init) {
        super(components, {
            ...init,
            name: 'helia:bitswap:session'
        });
        this.wantList = components.wantList;
        this.network = components.network;
    }
    async queryProvider(cid, provider, options) {
        this.log('sending WANT-BLOCK for %c to %p', cid, provider);
        const result = await this.wantList.wantSessionBlock(cid, provider, options);
        this.log('%p %s %c', provider, result.has ? 'has' : 'does not have', cid);
        if (result.has && result.block != null) {
            return result.block;
        }
        throw new Error('Provider did not have block');
    }
    async *findNewProviders(cid, options = {}) {
        for await (const provider of this.network.findProviders(cid, options)) {
            yield provider.id;
        }
    }
    toEvictionKey(provider) {
        return provider.toMultihash().bytes;
    }
    equals(providerA, providerB) {
        return providerA.equals(providerB);
    }
}
export function createBitswapSession(components, init) {
    return new BitswapSession(components, init);
}
//# sourceMappingURL=session.js.map