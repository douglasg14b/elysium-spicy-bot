/**
 * A size in bytes, for a person to read: "12 KB", "2.1 MB", "200 MB".
 *
 * Counted in 1024s, as the server counts its caps (`MIB` in `src/shared/byteSizes.ts`), so
 * the Uploads page's "of 200 MB" says the same number as the server's own "past 200 MB"
 * refusal — in 1000s that cap would read "209.7 MB" and the two would disagree.
 */

const KIB = 1024;
const MIB = KIB * KIB;

/**
 * How the last digit is reached. `down` for an amount used against a cap, so a server with
 * room left never reads "200 MB of 200 MB"; `nearest` for anything else.
 */
export type ByteRounding = 'nearest' | 'down';

function rounded(value: number, rounding: ByteRounding): number {
    return rounding === 'down' ? Math.floor(value) : Math.round(value);
}

export function formatByteSize(bytes: number, rounding: ByteRounding = 'nearest'): string {
    if (bytes === 1) return '1 byte';
    if (bytes < KIB) return `${bytes} bytes`;
    // Rounded within the unit, then promoted if that rounding reached the next one: 1023.9 KB is "1 MB".
    const kilobytes = rounded(bytes / KIB, rounding);
    if (kilobytes < KIB) return `${kilobytes} KB`;
    // One decimal place, with a trailing `.0` dropped: 8 → "8", 2.14 → "2.1".
    return `${rounded((bytes / MIB) * 10, rounding) / 10} MB`;
}
