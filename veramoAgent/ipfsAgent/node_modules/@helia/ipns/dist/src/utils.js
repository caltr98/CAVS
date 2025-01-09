export const IDENTITY_CODEC = 0x0;
export const SHA2_256_CODEC = 0x12;
export function isCodec(digest, codec) {
    return digest.code === codec;
}
//# sourceMappingURL=utils.js.map