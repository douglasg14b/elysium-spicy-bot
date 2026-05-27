import { CARD_FONT_BOLD_URL, CARD_FONT_REGULAR_URL } from './cardTheme';

export type CardFont = {
    name: string;
    data: ArrayBuffer;
    weight: 400 | 700;
    style: 'normal';
};

let cachedFonts: CardFont[] | null = null;

export async function loadCardFonts(fetchImpl: typeof fetch = fetch): Promise<CardFont[]> {
    if (cachedFonts) {
        return cachedFonts;
    }

    const [regularResponse, boldResponse] = await Promise.all([
        fetchImpl(CARD_FONT_REGULAR_URL),
        fetchImpl(CARD_FONT_BOLD_URL),
    ]);

    if (!regularResponse.ok || !boldResponse.ok) {
        throw new Error('Failed to load card fonts');
    }

    cachedFonts = [
        {
            name: 'Inter',
            data: await regularResponse.arrayBuffer(),
            weight: 400,
            style: 'normal',
        },
        {
            name: 'Inter',
            data: await boldResponse.arrayBuffer(),
            weight: 700,
            style: 'normal',
        },
    ];

    return cachedFonts;
}

export function resetCardFontCacheForTests(): void {
    cachedFonts = null;
}

/** MIME types Satori can parse for `<img src="data:...">` (not WebP/AVIF). */
const SATORI_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif']);

/**
 * Detect image MIME from magic bytes (aligned with Satori's detector).
 * Returns null when unknown or unsupported for card rendering.
 */
export function detectCardImageMime(buffer: Buffer): string | null {
    if (buffer.length < 4) {
        return null;
    }

    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'image/jpeg';
    }

    if (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47
    ) {
        return 'image/png';
    }

    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
        return 'image/gif';
    }

    if (
        buffer.length >= 12 &&
        buffer[0] === 0x52 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x46 &&
        buffer[8] === 0x57 &&
        buffer[9] === 0x45 &&
        buffer[10] === 0x42 &&
        buffer[11] === 0x50
    ) {
        return 'image/webp';
    }

    if (
        buffer.length >= 12 &&
        buffer[4] === 0x66 &&
        buffer[5] === 0x74 &&
        buffer[6] === 0x79 &&
        buffer[7] === 0x70 &&
        buffer[8] === 0x61 &&
        buffer[9] === 0x76 &&
        buffer[10] === 0x69 &&
        buffer[11] === 0x66
    ) {
        return 'image/avif';
    }

    return null;
}

export async function fetchImageAsDataUri(
    url: string,
    fetchImpl: typeof fetch = fetch
): Promise<string | null> {
    try {
        const response = await fetchImpl(url);
        if (!response.ok) {
            return null;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const mime = detectCardImageMime(buffer);

        if (!mime || !SATORI_IMAGE_MIME_TYPES.has(mime)) {
            return null;
        }

        return `data:${mime};base64,${buffer.toString('base64')}`;
    } catch {
        return null;
    }
}
