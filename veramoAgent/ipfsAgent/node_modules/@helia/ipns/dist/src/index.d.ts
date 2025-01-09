/**
 * @packageDocumentation
 *
 * IPNS operations using a Helia node
 *
 * @example Getting started
 *
 * With {@link IPNSRouting} routers:
 *
 * ```TypeScript
 * import { createHelia } from 'helia'
 * import { ipns } from '@helia/ipns'
 * import { unixfs } from '@helia/unixfs'
 * import { generateKeyPair } from '@libp2p/crypto/keys'
 *
 * const helia = await createHelia()
 * const name = ipns(helia)
 *
 * // create a keypair to publish an IPNS name
 * const privateKey = await generateKeyPair('Ed25519')
 *
 * // store some data to publish
 * const fs = unixfs(helia)
 * const cid = await fs.addBytes(Uint8Array.from([0, 1, 2, 3, 4]))
 *
 * // publish the name
 * await name.publish(privateKey, cid)
 *
 * // resolve the name
 * const result = await name.resolve(privateKey.publicKey)
 *
 * console.info(result.cid, result.path)
 * ```
 *
 * @example Publishing a recursive record
 *
 * A recursive record is a one that points to another record rather than to a
 * value.
 *
 * ```TypeScript
 * import { createHelia } from 'helia'
 * import { ipns } from '@helia/ipns'
 * import { unixfs } from '@helia/unixfs'
 * import { generateKeyPair } from '@libp2p/crypto/keys'
 *
 * const helia = await createHelia()
 * const name = ipns(helia)
 *
 * // create a keypair to publish an IPNS name
 * const privateKey = await generateKeyPair('Ed25519')
 *
 * // store some data to publish
 * const fs = unixfs(helia)
 * const cid = await fs.addBytes(Uint8Array.from([0, 1, 2, 3, 4]))
 *
 * // publish the name
 * await name.publish(privateKey, cid)
 *
 * // create another keypair to re-publish the original record
 * const recursivePrivateKey = await generateKeyPair('Ed25519')
 *
 * // publish the recursive name
 * await name.publish(recursivePrivateKey, privateKey.publicKey)
 *
 * // resolve the name recursively - it resolves until a CID is found
 * const result = await name.resolve(recursivePrivateKey.publicKey)
 * console.info(result.cid.toString() === cid.toString()) // true
 * ```
 *
 * @example Publishing a record with a path
 *
 * It is possible to publish CIDs with an associated path.
 *
 * ```TypeScript
 * import { createHelia } from 'helia'
 * import { ipns } from '@helia/ipns'
 * import { unixfs } from '@helia/unixfs'
 * import { generateKeyPair } from '@libp2p/crypto/keys'
 *
 * const helia = await createHelia()
 * const name = ipns(helia)
 *
 * // create a keypair to publish an IPNS name
 * const privateKey = await generateKeyPair('Ed25519')
 *
 * // store some data to publish
 * const fs = unixfs(helia)
 * const fileCid = await fs.addBytes(Uint8Array.from([0, 1, 2, 3, 4]))
 *
 * // store the file in a directory
 * const dirCid = await fs.addDirectory()
 * const finalDirCid = await fs.cp(fileCid, dirCid, '/foo.txt')
 *
 * // publish the name
 * await name.publish(privateKey, `/ipfs/${finalDirCid}/foo.txt`)
 *
 * // resolve the name
 * const result = await name.resolve(privateKey.publicKey)
 *
 * console.info(result.cid, result.path) // QmFoo.. 'foo.txt'
 * ```
 *
 * @example Using custom PubSub router
 *
 * Additional IPNS routers can be configured - these enable alternative means to
 * publish and resolve IPNS names.
 *
 * One example is the PubSub router - this requires an instance of Helia with
 * libp2p PubSub configured.
 *
 * It works by subscribing to a pubsub topic for each IPNS name that we try to
 * resolve. Updated IPNS records are shared on these topics so an update must
 * occur before the name is resolvable.
 *
 * This router is only suitable for networks where IPNS updates are frequent
 * and multiple peers are listening on the topic(s), otherwise update messages
 * may fail to be published with "Insufficient peers" errors.
 *
 * ```TypeScript
 * import { createHelia, libp2pDefaults } from 'helia'
 * import { ipns } from '@helia/ipns'
 * import { pubsub } from '@helia/ipns/routing'
 * import { unixfs } from '@helia/unixfs'
 * import { gossipsub } from '@chainsafe/libp2p-gossipsub'
 * import { generateKeyPair } from '@libp2p/crypto/keys'
 * import type { Libp2p, PubSub } from '@libp2p/interface'
 * import type { DefaultLibp2pServices } from 'helia'
 *
 * const libp2pOptions = libp2pDefaults()
 * libp2pOptions.services.pubsub = gossipsub()
 *
 * const helia = await createHelia<Libp2p<DefaultLibp2pServices & { pubsub: PubSub }>>({
 *   libp2p: libp2pOptions
 * })
 * const name = ipns(helia, {
 *  routers: [
 *    pubsub(helia)
 *  ]
 * })
 *
 * // create a keypair to publish an IPNS name
 * const privateKey = await generateKeyPair('Ed25519')
 *
 * // store some data to publish
 * const fs = unixfs(helia)
 * const cid = await fs.addBytes(Uint8Array.from([0, 1, 2, 3, 4]))
 *
 * // publish the name
 * await name.publish(privateKey, cid)
 *
 * // resolve the name
 * const result = await name.resolve(privateKey.publicKey)
 * ```
 *
 * @example Using custom DNS over HTTPS resolvers
 *
 * To use custom resolvers, configure Helia's `dns` option:
 *
 * ```TypeScript
 * import { createHelia } from 'helia'
 * import { ipns } from '@helia/ipns'
 * import { dns } from '@multiformats/dns'
 * import { dnsOverHttps } from '@multiformats/dns/resolvers'
 * import { helia } from '@helia/ipns/routing'
 *
 * const node = await createHelia({
 *   dns: dns({
 *     resolvers: {
 *       '.': dnsOverHttps('https://private-dns-server.me/dns-query')
 *     }
 *   })
 * })
 * const name = ipns(node, {
 *  routers: [
 *    helia(node.routing)
 *  ]
 * })
 *
 * const result = name.resolveDNSLink('some-domain-with-dnslink-entry.com')
 * ```
 *
 * @example Resolving a domain with a dnslink entry
 *
 * Calling `resolveDNSLink` with the `@helia/ipns` instance:
 *
 * ```TypeScript
 * // resolve a CID from a TXT record in a DNS zone file, using the default
 * // resolver for the current platform eg:
 * // > dig _dnslink.ipfs.io TXT
 * // ;; ANSWER SECTION:
 * // _dnslink.ipfs.io.          60     IN      TXT     "dnslink=/ipns/website.ipfs.io"
 * // > dig _dnslink.website.ipfs.io TXT
 * // ;; ANSWER SECTION:
 * // _dnslink.website.ipfs.io.  60     IN      TXT     "dnslink=/ipfs/QmWebsite"
 *
 * import { createHelia } from 'helia'
 * import { ipns } from '@helia/ipns'
 *
 * const node = await createHelia()
 * const name = ipns(node)
 *
 * const { answer } = await name.resolveDNSLink('ipfs.io')
 *
 * console.info(answer)
 * // { data: '/ipfs/QmWebsite' }
 * ```
 *
 * @example Using DNS-Over-HTTPS
 *
 * This example uses the Mozilla provided RFC 1035 DNS over HTTPS service. This
 * uses binary DNS records so requires extra dependencies to process the
 * response which can increase browser bundle sizes.
 *
 * If this is a concern, use the DNS-JSON-Over-HTTPS resolver instead.
 *
 * ```TypeScript
 * import { createHelia } from 'helia'
 * import { ipns } from '@helia/ipns'
 * import { dns } from '@multiformats/dns'
 * import { dnsOverHttps } from '@multiformats/dns/resolvers'
 *
 * const node = await createHelia({
 *   dns: dns({
 *     resolvers: {
 *       '.': dnsOverHttps('https://mozilla.cloudflare-dns.com/dns-query')
 *     }
 *   })
 * })
 * const name = ipns(node)
 *
 * const result = await name.resolveDNSLink('ipfs.io')
 * ```
 *
 * @example Using DNS-JSON-Over-HTTPS
 *
 * DNS-JSON-Over-HTTPS resolvers use the RFC 8427 `application/dns-json` and can
 * result in a smaller browser bundle due to the response being plain JSON.
 *
 * ```TypeScript
 * import { createHelia } from 'helia'
 * import { ipns } from '@helia/ipns'
 * import { dns } from '@multiformats/dns'
 * import { dnsJsonOverHttps } from '@multiformats/dns/resolvers'
 *
 * const node = await createHelia({
 *   dns: dns({
 *     resolvers: {
 *       '.': dnsJsonOverHttps('https://mozilla.cloudflare-dns.com/dns-query')
 *     }
 *   })
 * })
 * const name = ipns(node)
 *
 * const result = await name.resolveDNSLink('ipfs.io')
 * ```
 */
import { type IPNSRecord } from 'ipns';
import { ipnsValidator } from 'ipns/validator';
import { CID } from 'multiformats/cid';
import type { IPNSRouting, IPNSRoutingEvents } from './routing/index.js';
import type { Routing } from '@helia/interface';
import type { AbortOptions, ComponentLogger, PrivateKey, PublicKey } from '@libp2p/interface';
import type { Answer, DNS, ResolveDnsProgressEvents } from '@multiformats/dns';
import type { Datastore } from 'interface-datastore';
import type { MultihashDigest } from 'multiformats/hashes/interface';
import type { ProgressEvent, ProgressOptions } from 'progress-events';
export type PublishProgressEvents = ProgressEvent<'ipns:publish:start'> | ProgressEvent<'ipns:publish:success', IPNSRecord> | ProgressEvent<'ipns:publish:error', Error>;
export type ResolveProgressEvents = ProgressEvent<'ipns:resolve:start', unknown> | ProgressEvent<'ipns:resolve:success', IPNSRecord> | ProgressEvent<'ipns:resolve:error', Error>;
export type RepublishProgressEvents = ProgressEvent<'ipns:republish:start', unknown> | ProgressEvent<'ipns:republish:success', IPNSRecord> | ProgressEvent<'ipns:republish:error', {
    record: IPNSRecord;
    err: Error;
}>;
export type ResolveDNSLinkProgressEvents = ResolveProgressEvents | IPNSRoutingEvents | ResolveDnsProgressEvents;
export interface PublishOptions extends AbortOptions, ProgressOptions<PublishProgressEvents | IPNSRoutingEvents> {
    /**
     * Time duration of the record in ms (default: 24hrs)
     */
    lifetime?: number;
    /**
     * Only publish to a local datastore (default: false)
     */
    offline?: boolean;
    /**
     * By default a IPNS V1 and a V2 signature is added to every record. Pass
     * false here to only add a V2 signature. (default: true)
     */
    v1Compatible?: boolean;
}
export interface ResolveOptions extends AbortOptions, ProgressOptions<ResolveProgressEvents | IPNSRoutingEvents> {
    /**
     * Do not query the network for the IPNS record
     *
     * @default false
     */
    offline?: boolean;
    /**
     * Do not use cached IPNS Record entries
     *
     * @default false
     */
    nocache?: boolean;
}
export interface ResolveDNSLinkOptions extends AbortOptions, ProgressOptions<ResolveDNSLinkProgressEvents> {
    /**
     * Do not query the network for the IPNS record
     *
     * @default false
     */
    offline?: boolean;
    /**
     * Do not use cached DNS entries
     *
     * @default false
     */
    nocache?: boolean;
    /**
     * When resolving DNSLink records that resolve to other DNSLink records, limit
     * how many times we will recursively resolve them.
     *
     * @default 32
     */
    maxRecursiveDepth?: number;
}
export interface RepublishOptions extends AbortOptions, ProgressOptions<RepublishProgressEvents | IPNSRoutingEvents> {
    /**
     * The republish interval in ms (default: 23hrs)
     */
    interval?: number;
}
export interface ResolveResult {
    /**
     * The CID that was resolved
     */
    cid: CID;
    /**
     * Any path component that was part of the resolved record
     *
     * @default ""
     */
    path: string;
}
export interface IPNSResolveResult extends ResolveResult {
    /**
     * The resolved record
     */
    record: IPNSRecord;
}
export interface DNSLinkResolveResult extends ResolveResult {
    /**
     * The resolved record
     */
    answer: Answer;
}
export interface IPNS {
    /**
     * Creates an IPNS record signed by the passed PeerId that will resolve to the passed value
     *
     * If the value is a PeerId, a recursive IPNS record will be created.
     */
    publish(key: PrivateKey, value: CID | PublicKey | MultihashDigest<0x00 | 0x12> | string, options?: PublishOptions): Promise<IPNSRecord>;
    /**
     * Accepts a public key formatted as a libp2p PeerID and resolves the IPNS record
     * corresponding to that public key until a value is found
     */
    resolve(key: PublicKey | MultihashDigest<0x00 | 0x12>, options?: ResolveOptions): Promise<IPNSResolveResult>;
    /**
     * Resolve a CID from a dns-link style IPNS record
     */
    resolveDNSLink(domain: string, options?: ResolveDNSLinkOptions): Promise<DNSLinkResolveResult>;
    /**
     * Periodically republish all IPNS records found in the datastore
     */
    republish(options?: RepublishOptions): void;
}
export type { IPNSRouting } from './routing/index.js';
export interface IPNSComponents {
    datastore: Datastore;
    routing: Routing;
    dns: DNS;
    logger: ComponentLogger;
}
export interface IPNSOptions {
    routers?: IPNSRouting[];
}
export declare function ipns(components: IPNSComponents, { routers }?: IPNSOptions): IPNS;
export { ipnsValidator, type IPNSRoutingEvents };
export { ipnsSelector } from 'ipns/selector';
//# sourceMappingURL=index.d.ts.map