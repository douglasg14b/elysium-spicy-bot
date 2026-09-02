import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { fetchImageAsDataUri, loadCardFonts } from '../../../leveling/cards/shared/cardRenderAssets';
import {
    buildActiveWarningsCardElement,
    type ActiveWarningsCardDisplayEntry,
} from './buildActiveWarningsCardElement';
import { ACTIVE_WARNINGS_CARD_WIDTH, getActiveWarningsCardHeight } from './activeWarningsCardConstants';

export type ActiveWarningsCardMember = {
    userId: string;
    displayName: string;
    avatarUrl: string | null;
};

export type RenderActiveWarningsCardInput = {
    guildName: string;
    entries: Array<Omit<ActiveWarningsCardDisplayEntry, 'displayName' | 'avatarDataUri'>>;
    members: ActiveWarningsCardMember[];
    totalActive: number;
    fetchImpl?: typeof fetch;
};

export async function renderActiveWarningsCard(input: RenderActiveWarningsCardInput): Promise<Buffer> {
    const fetchImpl = input.fetchImpl ?? fetch;
    const memberById = new Map(input.members.map((member) => [member.userId, member]));

    const uniqueMembers = [...new Map(input.members.map((member) => [member.userId, member])).values()];
    const avatarDataUris = await Promise.all(
        uniqueMembers.map(async (member) => ({
            userId: member.userId,
            avatarDataUri: member.avatarUrl ? await fetchImageAsDataUri(member.avatarUrl, fetchImpl) : null,
        }))
    );
    const avatarById = new Map(avatarDataUris.map((entry) => [entry.userId, entry.avatarDataUri]));

    const entries: ActiveWarningsCardDisplayEntry[] = input.entries.map((entry) => {
        const member = memberById.get(entry.userId);

        return {
            ...entry,
            displayName: member?.displayName ?? `Member ${entry.userId.slice(-4)}`,
            avatarDataUri: avatarById.get(entry.userId) ?? null,
        };
    });

    const fonts = await loadCardFonts(fetchImpl);
    const element = buildActiveWarningsCardElement({
        guildName: input.guildName,
        entries,
        totalActive: input.totalActive,
    });

    const svg = await satori(element, {
        width: ACTIVE_WARNINGS_CARD_WIDTH,
        height: getActiveWarningsCardHeight(entries.length),
        fonts,
    });

    return new Resvg(svg, {
        fitTo: {
            mode: 'width',
            value: ACTIVE_WARNINGS_CARD_WIDTH,
        },
        font: {
            loadSystemFonts: false,
        },
    })
        .render()
        .asPng();
}
