/**
 * @packageDocumentation
 *
 * `@helia/unixfs` is an implementation of a {@link https://github.com/ipfs/specs/blob/main/UNIXFS.md UnixFS filesystem} compatible with {@link https://github.com/ipfs/helia Helia}.
 *
 * See the [API docs](https://ipfs.github.io/helia/modules/_helia_unixfs.html) for all available operations.
 *
 * @example Creating files and directories
 *
 * ```typescript
 * import { createHelia } from 'helia'
 * import { unixfs } from '@helia/unixfs'
 *
 * const helia = await createHelia()
 * const fs = unixfs(helia)
 *
 * // create an empty dir and a file, then add the file to the dir
 * const emptyDirCid = await fs.addDirectory()
 * const fileCid = await fs.addBytes(Uint8Array.from([0, 1, 2, 3]))
 * const updateDirCid = await fs.cp(fileCid, emptyDirCid, 'foo.txt')
 *
 * // or doing the same thing as a stream
 * for await (const entry of fs.addAll([{
 *   path: 'foo.txt',
 *   content: Uint8Array.from([0, 1, 2, 3])
 * }])) {
 *   console.info(entry)
 * }
 * ```
 *
 * @example Recursively adding a directory
 *
 * Node.js-compatibly environments only:
 *
 * ```typescript
 * import { createHelia } from 'helia'
 * import { unixfs } from '@helia/unixfs'
 * import { globSource } from '@helia/unixfs'
 *
 * const helia = await createHelia()
 * const fs = unixfs(helia)
 *
 * for await (const entry of fs.addAll(globSource('path/to/containing/dir', 'glob-pattern'))) {
 *   console.info(entry)
 * }
 * ```
 */
import { UnixFS as UnixFSClass } from './unixfs.js';
/**
 * Create a {@link UnixFS} instance for use with {@link https://github.com/ipfs/helia Helia}
 */
export function unixfs(helia) {
    return new UnixFSClass(helia);
}
export { globSource } from './utils/glob-source.js';
export { urlSource } from './utils/url-source.js';
//# sourceMappingURL=index.js.map