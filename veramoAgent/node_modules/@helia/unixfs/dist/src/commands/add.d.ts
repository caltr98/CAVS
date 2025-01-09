import { type ByteStream, type DirectoryCandidate, type FileCandidate, type ImportCandidateStream, type ImporterOptions, type ImportResult } from 'ipfs-unixfs-importer';
import type { PutStore } from '../unixfs.js';
import type { CID } from 'multiformats/cid';
export declare function addAll(source: ImportCandidateStream, blockstore: PutStore, options?: Partial<ImporterOptions>): AsyncGenerator<ImportResult, void, unknown>;
export declare function addBytes(bytes: Uint8Array, blockstore: PutStore, options?: Partial<ImporterOptions>): Promise<CID>;
export declare function addByteStream(bytes: ByteStream, blockstore: PutStore, options?: Partial<ImporterOptions>): Promise<CID>;
export declare function addFile(file: FileCandidate, blockstore: PutStore, options?: Partial<ImporterOptions>): Promise<CID>;
export declare function addDirectory(dir: Partial<DirectoryCandidate>, blockstore: PutStore, options?: Partial<ImporterOptions>): Promise<CID>;
//# sourceMappingURL=add.d.ts.map