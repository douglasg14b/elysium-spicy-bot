import { crc32, deflateSync } from 'node:zlib';

/**
 * A real, decodable PNG of a soft gradient, for the preview's uploaded pictures — the server
 * keeps only bytes it can read as a picture, and a browser draws only one it can decode, so
 * the eight-byte signature the tests send would show as a broken image.
 */

/** One colour, 0–255 a channel. */
export type Rgb = readonly [number, number, number];

function chunk(type: string, data: Buffer): Buffer {
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, checksum]);
}

/** `width` × `height`, blending `from` (top left) into `to` (bottom right), with a glow towards `glow`. */
export function gradientPng(width: number, height: number, from: Rgb, to: Rgb, glow: Rgb): Buffer {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.writeUInt8(8, 8); // bit depth
    header.writeUInt8(2, 9); // truecolour
    // Compression, filter and interlace stay 0.

    const rows = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y += 1) {
        const row = y * (width * 3 + 1);
        for (let x = 0; x < width; x += 1) {
            const along = (x / width + y / height) / 2;
            const distance = Math.hypot(x / width - 0.3, y / height - 0.35);
            const lit = Math.max(0, 1 - distance * 1.6);
            for (let channel = 0; channel < 3; channel += 1) {
                const base = (from[channel] ?? 0) * (1 - along) + (to[channel] ?? 0) * along;
                rows[row + 1 + x * 3 + channel] = Math.round(base * (1 - lit * 0.6) + (glow[channel] ?? 0) * lit * 0.6);
            }
        }
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(rows)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}
