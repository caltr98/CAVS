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
import { NotFoundError, isPublicKey } from '@libp2p/interface';
import { logger } from '@libp2p/logger';
import { createIPNSRecord, marshalIPNSRecord, multihashToIPNSRoutingKey, unmarshalIPNSRecord } from 'ipns';
import { ipnsSelector } from 'ipns/selector';
import { ipnsValidator } from 'ipns/validator';
import { base36 } from 'multiformats/bases/base36';
import { base58btc } from 'multiformats/bases/base58';
import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';
import { CustomProgressEvent } from 'progress-events';
import { resolveDNSLink } from './dnslink.js';
import { InvalidValueError, RecordsFailedValidationError, UnsupportedMultibasePrefixError, UnsupportedMultihashCodecError } from './errors.js';
import { helia } from './routing/helia.js';
import { localStore } from './routing/local-store.js';
import { isCodec, IDENTITY_CODEC, SHA2_256_CODEC } from './utils.js';
const log = logger('helia:ipns');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DEFAULT_LIFETIME_MS = 24 * HOUR;
const DEFAULT_REPUBLISH_INTERVAL_MS = 23 * HOUR;
const DEFAULT_TTL_NS = BigInt(HOUR) * 1000000n;
const bases = {
    [base36.prefix]: base36,
    [base58btc.prefix]: base58btc
};
class DefaultIPNS {
    routers;
    localStore;
    timeout;
    dns;
    log;
    constructor(components, routers = []) {
        this.routers = [
            helia(components.routing),
            ...routers
        ];
        this.localStore = localStore(components.datastore);
        this.dns = components.dns;
        this.log = components.logger.forComponent('helia:ipns');
    }
    async publish(key, value, options = {}) {
        try {
            let sequenceNumber = 1n;
            const routingKey = multihashToIPNSRoutingKey(key.publicKey.toMultihash());
            if (await this.localStore.has(routingKey, options)) {
                // if we have published under this key before, increment the sequence number
                const { record } = await this.localStore.get(routingKey, options);
                const existingRecord = unmarshalIPNSRecord(record);
                sequenceNumber = existingRecord.sequence + 1n;
            }
            // create record
            const record = await createIPNSRecord(key, value, sequenceNumber, options.lifetime ?? DEFAULT_LIFETIME_MS, options);
            const marshaledRecord = marshalIPNSRecord(record);
            await this.localStore.put(routingKey, marshaledRecord, options);
            if (options.offline !== true) {
                // publish record to routing
                await Promise.all(this.routers.map(async (r) => { await r.put(routingKey, marshaledRecord, options); }));
            }
            return record;
        }
        catch (err) {
            options.onProgress?.(new CustomProgressEvent('ipns:publish:error', err));
            throw err;
        }
    }
    async resolve(key, options = {}) {
        const digest = isPublicKey(key) ? key.toMultihash() : key;
        const routingKey = multihashToIPNSRoutingKey(digest);
        const record = await this.#findIpnsRecord(routingKey, options);
        return {
            ...(await this.#resolve(record.value, options)),
            record
        };
    }
    async resolveDNSLink(domain, options = {}) {
        const dnslink = await resolveDNSLink(domain, this.dns, this.log, options);
        return {
            ...(await this.#resolve(dnslink.value, options)),
            answer: dnslink.answer
        };
    }
    republish(options = {}) {
        if (this.timeout != null) {
            throw new Error('Republish is already running');
        }
        options.signal?.addEventListener('abort', () => {
            clearTimeout(this.timeout);
        });
        async function republish() {
            const startTime = Date.now();
            options.onProgress?.(new CustomProgressEvent('ipns:republish:start'));
            const finishType = Date.now();
            const timeTaken = finishType - startTime;
            let nextInterval = DEFAULT_REPUBLISH_INTERVAL_MS - timeTaken;
            if (nextInterval < 0) {
                nextInterval = options.interval ?? DEFAULT_REPUBLISH_INTERVAL_MS;
            }
            setTimeout(() => {
                republish().catch(err => {
                    log.error('error republishing', err);
                });
            }, nextInterval);
        }
        this.timeout = setTimeout(() => {
            republish().catch(err => {
                log.error('error republishing', err);
            });
        }, options.interval ?? DEFAULT_REPUBLISH_INTERVAL_MS);
    }
    async #resolve(ipfsPath, options = {}) {
        const parts = ipfsPath.split('/');
        try {
            const scheme = parts[1];
            if (scheme === 'ipns') {
                const str = parts[2];
                const prefix = str.substring(0, 1);
                let buf;
                if (prefix === '1' || prefix === 'Q') {
                    buf = base58btc.decode(`z${str}`);
                }
                else if (bases[prefix] != null) {
                    buf = bases[prefix].decode(str);
                }
                else {
                    throw new UnsupportedMultibasePrefixError(`Unsupported multibase prefix "${prefix}"`);
                }
                let digest;
                try {
                    digest = Digest.decode(buf);
                }
                catch {
                    digest = CID.decode(buf).multihash;
                }
                if (!isCodec(digest, IDENTITY_CODEC) && !isCodec(digest, SHA2_256_CODEC)) {
                    throw new UnsupportedMultihashCodecError(`Unsupported multihash codec "${digest.code}"`);
                }
                const { cid } = await this.resolve(digest, options);
                const path = parts.slice(3).join('/');
                return {
                    cid,
                    path
                };
            }
            else if (scheme === 'ipfs') {
                const cid = CID.parse(parts[2]);
                const path = parts.slice(3).join('/');
                return {
                    cid,
                    path
                };
            }
        }
        catch (err) {
            log.error('error parsing ipfs path', err);
        }
        log.error('invalid ipfs path %s', ipfsPath);
        throw new InvalidValueError('Invalid value');
    }
    async #findIpnsRecord(routingKey, options = {}) {
        const records = [];
        const cached = await this.localStore.has(routingKey, options);
        if (cached) {
            log('record is present in the cache');
            if (options.nocache !== true) {
                try {
                    // check the local cache first
                    const { record, created } = await this.localStore.get(routingKey, options);
                    this.log('record retrieved from cache');
                    // validate the record
                    await ipnsValidator(routingKey, record);
                    this.log('record was valid');
                    // check the TTL
                    const ipnsRecord = unmarshalIPNSRecord(record);
                    // IPNS TTL is in nanoseconds, convert to milliseconds, default to one
                    // hour
                    const ttlMs = Number((ipnsRecord.ttl ?? DEFAULT_TTL_NS) / 1000000n);
                    const ttlExpires = created.getTime() + ttlMs;
                    if (ttlExpires > Date.now()) {
                        // the TTL has not yet expired, return the cached record
                        this.log('record TTL was valid');
                        return ipnsRecord;
                    }
                    if (options.offline === true) {
                        // the TTL has expired but we are skipping the routing search
                        this.log('record TTL has been reached but we are resolving offline-only, returning record');
                        return ipnsRecord;
                    }
                    this.log('record TTL has been reached, searching routing for updates');
                    // add the local record to our list of resolved record, and also
                    // search the routing for updates - the most up to date record will be
                    // returned
                    records.push(record);
                }
                catch (err) {
                    this.log('cached record was invalid', err);
                    await this.localStore.delete(routingKey, options);
                }
            }
            else {
                log('ignoring local cache due to nocache=true option');
            }
        }
        if (options.offline === true) {
            throw new NotFoundError('Record was not present in the cache or has expired');
        }
        log('did not have record locally');
        let foundInvalid = 0;
        await Promise.all(this.routers.map(async (router) => {
            let record;
            try {
                record = await router.get(routingKey, {
                    ...options,
                    validate: false
                });
            }
            catch (err) {
                log.error('error finding IPNS record', err);
                return;
            }
            try {
                await ipnsValidator(routingKey, record);
                records.push(record);
            }
            catch (err) {
                // we found a record, but the validator rejected it
                foundInvalid++;
                log.error('error finding IPNS record', err);
            }
        }));
        if (records.length === 0) {
            if (foundInvalid > 0) {
                throw new RecordsFailedValidationError(`${foundInvalid > 1 ? `${foundInvalid} records` : 'Record'} found for routing key ${foundInvalid > 1 ? 'were' : 'was'} invalid`);
            }
            throw new NotFoundError('Could not find record for routing key');
        }
        const record = records[ipnsSelector(routingKey, records)];
        await this.localStore.put(routingKey, record, options);
        return unmarshalIPNSRecord(record);
    }
}
export function ipns(components, { routers = [] } = {}) {
    return new DefaultIPNS(components, routers);
}
export { ipnsValidator };
export { ipnsSelector } from 'ipns/selector';
//# sourceMappingURL=index.js.map