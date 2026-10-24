import { describe, expect, it } from 'vitest';
import { formatByteSize } from '../byteSize';

const MIB = 1024 * 1024;

describe('formatByteSize', () => {
    it('counts in 1024s, so the server cap reads as the server says it', () => {
        expect(formatByteSize(200 * MIB)).toBe('200 MB');
        expect(formatByteSize(8 * MIB)).toBe('8 MB');
    });

    it('gives megabytes one decimal place, and drops a trailing .0', () => {
        expect(formatByteSize(Math.round(38.4 * MIB))).toBe('38.4 MB');
        expect(formatByteSize(Math.round(2.14 * MIB))).toBe('2.1 MB');
        expect(formatByteSize(5 * MIB)).toBe('5 MB');
    });

    it('gives kilobytes whole, and moves up to megabytes when rounding reaches one', () => {
        expect(formatByteSize(12 * 1024)).toBe('12 KB');
        expect(formatByteSize(340 * 1024 + 300)).toBe('340 KB');
        expect(formatByteSize(MIB - 10)).toBe('1 MB');
    });

    it('says bytes below a kilobyte, and one byte in the singular', () => {
        expect(formatByteSize(0)).toBe('0 bytes');
        expect(formatByteSize(1)).toBe('1 byte');
        expect(formatByteSize(512)).toBe('512 bytes');
    });

    it('rounds down when asked, so an amount just under the cap never reads as the cap', () => {
        expect(formatByteSize(200 * MIB - 1, 'down')).toBe('199.9 MB');
        expect(formatByteSize(200 * MIB - 1)).toBe('200 MB');
        expect(formatByteSize(MIB - 10, 'down')).toBe('1023 KB');
        expect(formatByteSize(200 * MIB, 'down')).toBe('200 MB');
    });
});
