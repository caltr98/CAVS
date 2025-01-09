import { TrustlessGatewayBlockBroker } from './broker.js';
export const DEFAULT_ALLOW_INSECURE = false;
export const DEFAULT_ALLOW_LOCAL = false;
export function trustlessGateway(init = {}) {
    return (components) => new TrustlessGatewayBlockBroker(components, init);
}
//# sourceMappingURL=index.js.map