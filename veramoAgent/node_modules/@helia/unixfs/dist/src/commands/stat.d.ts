import type { StatOptions, UnixFSStats } from '../index.js';
import type { GetStore, HasStore } from '../unixfs.js';
import type { CID } from 'multiformats/cid';
export declare function stat(cid: CID, blockstore: GetStore & HasStore, options?: Partial<StatOptions>): Promise<UnixFSStats>;
//# sourceMappingURL=stat.d.ts.map