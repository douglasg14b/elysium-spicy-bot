import { describe, expect, it, vi } from 'vitest';
import { detectCardImageMime, fetchImageAsDataUri } from '../cardRenderAssets';

/** Minimal valid 1×1 PNG (IHDR + IDAT + IEND). */
const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
);

/** RIFF header with WEBP fourcc — Satori cannot render this. */
const WEBP_HEADER = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

describe('detectCardImageMime', () => {
    it('detects PNG, JPEG, and GIF', () => {
        expect(detectCardImageMime(TINY_PNG)).toBe('image/png');
        expect(detectCardImageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe('image/jpeg');
        expect(detectCardImageMime(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x00]))).toBe('image/gif');
    });

    it('detects WebP and AVIF as unsupported for cards', () => {
        expect(detectCardImageMime(WEBP_HEADER)).toBe('image/webp');
        expect(
            detectCardImageMime(
                Buffer.from([0x00, 0x00, 0x00, 0x00, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])
            )
        ).toBe('image/avif');
    });
});

describe('fetchImageAsDataUri', () => {
    it('returns a PNG data URI when bytes are PNG regardless of response Content-Type', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            headers: new Headers({ 'content-type': 'image/webp' }),
            arrayBuffer: async () => TINY_PNG.buffer.slice(TINY_PNG.byteOffset, TINY_PNG.byteOffset + TINY_PNG.byteLength),
        });

        const dataUri = await fetchImageAsDataUri('https://cdn.example/avatar.png', fetchImpl);

        expect(dataUri).toMatch(/^data:image\/png;base64,/);
    });

    it('returns null for WebP bytes so Satori does not crash', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            headers: new Headers({ 'content-type': 'image/webp' }),
            arrayBuffer: async () =>
                WEBP_HEADER.buffer.slice(
                    WEBP_HEADER.byteOffset,
                    WEBP_HEADER.byteOffset + WEBP_HEADER.byteLength
                ),
        });

        const dataUri = await fetchImageAsDataUri('https://cdn.example/avatar.webp', fetchImpl);

        expect(dataUri).toBeNull();
    });
});
