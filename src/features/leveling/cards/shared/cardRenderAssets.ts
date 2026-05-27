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

export async function fetchImageAsDataUri(
    url: string,
    fetchImpl: typeof fetch = fetch
): Promise<string | null> {
    try {
        const response = await fetchImpl(url);
        if (!response.ok) {
            return null;
        }

        const contentType = response.headers.get('content-type') ?? 'image/png';
        const buffer = Buffer.from(await response.arrayBuffer());

        return `data:${contentType};base64,${buffer.toString('base64')}`;
    } catch {
        return null;
    }
}
