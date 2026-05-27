import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import type { UserLevelProfile } from '../../logic/userLevelProfile';
import { fetchImageAsDataUri, loadLevelCardFonts } from './levelCardAssets';
import { buildLevelCardElement } from './buildLevelCardElement';
import { LEVEL_CARD_HEIGHT, LEVEL_CARD_WIDTH } from './levelCardConstants';

export type RenderLevelCardInput = {
    profile: UserLevelProfile;
    displayName: string;
    avatarUrl: string;
    fetchImpl?: typeof fetch;
};

export async function renderLevelCard(input: RenderLevelCardInput): Promise<Buffer> {
    const fetchImpl = input.fetchImpl ?? fetch;
    const [fonts, avatarDataUri] = await Promise.all([
        loadLevelCardFonts(fetchImpl),
        fetchImageAsDataUri(input.avatarUrl, fetchImpl),
    ]);

    const element = buildLevelCardElement({
        profile: input.profile,
        displayName: input.displayName,
        avatarDataUri,
    });

    const svg = await satori(element, {
        width: LEVEL_CARD_WIDTH,
        height: LEVEL_CARD_HEIGHT,
        fonts,
    });

    const png = new Resvg(svg, {
        fitTo: {
            mode: 'width',
            value: LEVEL_CARD_WIDTH,
        },
        font: {
            loadSystemFonts: false,
        },
    })
        .render()
        .asPng();

    return png;
}
