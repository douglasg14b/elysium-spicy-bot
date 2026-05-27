import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { fetchImageAsDataUri, loadCardFonts } from '../shared/cardRenderAssets';
import type { UserLevelStats } from '../../logic/loadUserLevelStats';
import { buildStatsCardElement } from './buildStatsCardElement';
import { STATS_CARD_HEIGHT, STATS_CARD_WIDTH } from './statsCardConstants';

export type RenderStatsCardInput = UserLevelStats & {
    displayName: string;
    avatarUrl?: string | null;
    fetchImpl?: typeof fetch;
};

export async function renderStatsCard(input: RenderStatsCardInput): Promise<Buffer> {
    const fetchImpl = input.fetchImpl ?? fetch;
    const [fonts, avatarDataUri] = await Promise.all([
        loadCardFonts(fetchImpl),
        input.avatarUrl ? fetchImageAsDataUri(input.avatarUrl, fetchImpl) : Promise.resolve(null),
    ]);

    const element = buildStatsCardElement({
        ...input,
        avatarDataUri,
    });

    const svg = await satori(element, {
        width: STATS_CARD_WIDTH,
        height: STATS_CARD_HEIGHT,
        fonts,
    });

    return new Resvg(svg, {
        fitTo: {
            mode: 'width',
            value: STATS_CARD_WIDTH,
        },
        font: {
            loadSystemFonts: false,
        },
    })
        .render()
        .asPng();
}
