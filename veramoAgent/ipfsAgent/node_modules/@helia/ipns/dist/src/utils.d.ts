import type { MultihashDigest } from 'multiformats/hashes/interface';
export declare const IDENTITY_CODEC = 0;
export declare const SHA2_256_CODEC = 18;
export declare function isCodec<T extends number>(digest: MultihashDigest, codec: T): digest is MultihashDigest<T>;
//# sourceMappingURL=utils.d.ts.map