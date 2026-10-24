import { describe, expect, it } from 'vitest';
import { detectImageType, type ImageContentType } from '../detectImageType';

/**
 * The sniffer is the only judge of what an upload is: the stored content type, and the
 * extension a picture is attached under, come from here and never from the file name. Each
 * lookalike below is something a name or a careless check would let through.
 */

/** `text` as the bytes it is. */
function ascii(text: string): number[] {
    return [...text].map((character) => character.charCodeAt(0));
}

/** `header` followed by some body bytes, as a real file would have. */
function file(header: readonly number[] | string): Uint8Array {
    const head = typeof header === 'string' ? ascii(header) : header;
    return Uint8Array.from([...head, 0x00, 0x10, 0x20, 0x30, 0xff, 0x00]);
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** `RIFF`, a little-endian chunk size, then the form type. */
function riff(form: string): number[] {
    return [...ascii('RIFF'), 0x24, 0x00, 0x00, 0x00, ...ascii(form)];
}

describe('detectImageType', () => {
    it.each<[string, Uint8Array, ImageContentType]>([
        ['a PNG', file(PNG), 'image/png'],
        ['a JPEG', file([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
        ['a GIF87a', file('GIF87a'), 'image/gif'],
        ['a GIF89a', file('GIF89a'), 'image/gif'],
        ['a WebP', file(riff('WEBP')), 'image/webp'],
    ])('reads %s by its magic bytes', (_label, bytes, expected) => {
        expect(detectImageType(bytes)).toBe(expected);
    });

    it.each<[string, Uint8Array]>([
        // What a file named `cat.png` holds when it is really a note.
        ['text in a file named .png', file('this is definitely a png, trust me')],
        ['an SVG, which can carry script', file('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
        ['a PNG header cut short', Uint8Array.from(PNG.slice(0, 7))],
        ['a RIFF that is not WebP', file(riff('WAVE'))],
        ['a WebP cut short before its form type', Uint8Array.from(riff('WEBP').slice(0, 11))],
        ['a GIF with an unknown version', file('GIF90a')],
        ['nothing at all', new Uint8Array(0)],
    ])('refuses %s', (_label, bytes) => {
        expect(detectImageType(bytes)).toBeNull();
    });
});
