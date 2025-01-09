import type { ResolveDNSLinkOptions } from './index.js';
import type { Logger } from '@libp2p/interface';
import type { Answer, DNS } from '@multiformats/dns';
export interface DNSLinkResult {
    answer: Answer;
    value: string;
}
export declare function resolveDNSLink(domain: string, dns: DNS, log: Logger, options?: ResolveDNSLinkOptions): Promise<DNSLinkResult>;
//# sourceMappingURL=dnslink.d.ts.map