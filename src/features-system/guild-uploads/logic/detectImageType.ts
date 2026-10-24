/** The content types a picture an upload may be, in the order the wire's enum lists them. */
export const IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** The content type of a picture an upload may be. */
export type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[number];

/**
 * The extension each picture type's stored file is named with when it is attached to a
 * message (`<uploadId>.<extension>`).
 */
export const IMAGE_EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
} as const satisfies Record<ImageContentType, string>;

/** `'GIF87a'` and friends as the bytes they are. */
function ascii(text: string): readonly number[] {
    return [...text].map((character) => character.charCodeAt(0));
}

const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE: readonly number[] = [0xff, 0xd8, 0xff];
const GIF87A_SIGNATURE = ascii('GIF87a');
const GIF89A_SIGNATURE = ascii('GIF89a');
const RIFF_SIGNATURE = ascii('RIFF');
const WEBP_SIGNATURE = ascii('WEBP');
/** Where `WEBP` sits in a RIFF file: after `RIFF` and the four-byte chunk size. */
const WEBP_SIGNATURE_OFFSET = 8;

/** Whether `bytes` holds `signature` starting at `offset`. A short buffer never does. */
function hasSignature(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
    if (bytes.length < offset + signature.length) return false;
    return signature.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * Which picture `bytes` is, read from its magic bytes, or `null` for anything else.
 *
 * The only judge of an upload's type: the stored content type and extension come from
 * here, never from the name the browser sent or the `Content-Type` it claimed. An SVG is
 * `null` on purpose — it is a document that can carry script, not a picture Discord shows.
 *
 * - PNG: `89 50 4E 47 0D 0A 1A 0A`
 * - JPEG: `FF D8 FF`
 * - GIF: `GIF87a` or `GIF89a`
 * - WebP: `RIFF`, a four-byte size, then `WEBP`
 */
export function detectImageType(bytes: Uint8Array): ImageContentType | null {
    if (hasSignature(bytes, PNG_SIGNATURE)) return 'image/png';
    if (hasSignature(bytes, JPEG_SIGNATURE)) return 'image/jpeg';
    if (hasSignature(bytes, GIF87A_SIGNATURE) || hasSignature(bytes, GIF89A_SIGNATURE)) return 'image/gif';
    if (hasSignature(bytes, RIFF_SIGNATURE) && hasSignature(bytes, WEBP_SIGNATURE, WEBP_SIGNATURE_OFFSET)) {
        return 'image/webp';
    }
    return null;
}
