import type { Routing } from '@helia/interface';
export declare const DEFAULT_TRUSTLESS_GATEWAYS: string[];
export interface HTTPGatwayRouterInit {
    gateways?: Array<URL | string>;
}
/**
 * Returns a static list of HTTP Gateways as providers
 */
export declare function httpGatewayRouting(init?: HTTPGatwayRouterInit): Partial<Routing>;
//# sourceMappingURL=http-gateway-routing.d.ts.map