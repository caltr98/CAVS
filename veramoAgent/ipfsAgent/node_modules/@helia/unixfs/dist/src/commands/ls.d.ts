import { type UnixFSEntry } from 'ipfs-unixfs-exporter';
import type { LsOptions } from '../index.js';
import type { GetStore } from '../unixfs.js';
import type { CID } from 'multiformats/cid';
export declare function ls(cid: CID, blockstore: GetStore, options?: Partial<LsOptions>): AsyncIterable<UnixFSEntry>;
//# sourceMappingURL=ls.d.ts.map