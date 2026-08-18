import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { fetchImageAsDataUri, loadCardFonts } from '../shared/cardRenderAssets';
import type { BelowThresholdReport } from '../../logic/belowThresholdReport';
import {
    buildBelowThresholdCardElement,
    type BelowThresholdCardDisplayEntry,
} from './buildBelowThresholdCardElement';
import {
    BELOW_THRESHOLD_CARD_WIDTH,
    getBelowThresholdCardHeight,
} from './belowThresholdCardConstants';

export type RenderBelowThresholdCardInput = {
    guildName: string;
    report: BelowThresholdReport;
    fetchImpl?: typeof fetch;
};

export async function renderBelowThresholdCard(input: RenderBelowThresholdCardInput): Promise<Buffer> {
    const fetchImpl = input.fetchImpl ?? fetch;

    const avatarDataUris = await Promise.all(
        input.report.cardEntries.map(async (entry) => ({
            userId: entry.userId,
            avatarDataUri: entry.avatarUrl
                ? await fetchImageAsDataUri(entry.avatarUrl, fetchImpl)
                : null,
        }))
    );
    const avatarById = new Map(avatarDataUris.map((entry) => [entry.userId, entry.avatarDataUri]));

    const cardEntries: BelowThresholdCardDisplayEntry[] = input.report.cardEntries.map(
        (entry, index) => ({
            ...entry,
            rank: index + 1,
            avatarDataUri: avatarById.get(entry.userId) ?? null,
        })
    );

    const fonts = await loadCardFonts(fetchImpl);
    const element = buildBelowThresholdCardElement({
        guildName: input.guildName,
        report: input.report,
        cardEntries,
    });

    const svg = await satori(element, {
        width: BELOW_THRESHOLD_CARD_WIDTH,
        height: getBelowThresholdCardHeight(cardEntries.length),
        fonts,
    });

    return new Resvg(svg, {
        fitTo: {
            mode: 'width',
            value: BELOW_THRESHOLD_CARD_WIDTH,
        },
        font: {
            loadSystemFonts: false,
        },
    })
        .render()
        .asPng();
}
