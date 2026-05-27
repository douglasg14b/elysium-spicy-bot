import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { fetchImageAsDataUri, loadCardFonts } from '../shared/cardRenderAssets';
import type { GuildLevelRankings } from '../../logic/loadGuildLevelRankings';
import {
    buildRankingsCardElement,
    type RankingsCardDisplayEntry,
} from './buildRankingsCardElement';
import { getRankingsCardHeight, RANKINGS_CARD_WIDTH } from './rankingsCardConstants';

export type RankingsCardMember = {
    userId: string;
    displayName: string;
    avatarUrl: string | null;
};

export type RenderRankingsCardInput = {
    guildName: string;
    rankings: GuildLevelRankings;
    members: RankingsCardMember[];
    fetchImpl?: typeof fetch;
};

export async function renderRankingsCard(input: RenderRankingsCardInput): Promise<Buffer> {
    const fetchImpl = input.fetchImpl ?? fetch;
    const memberById = new Map(input.members.map((member) => [member.userId, member]));

    const avatarDataUris = await Promise.all(
        input.members.map(async (member) => ({
            userId: member.userId,
            avatarDataUri: member.avatarUrl
                ? await fetchImageAsDataUri(member.avatarUrl, fetchImpl)
                : null,
        }))
    );
    const avatarById = new Map(avatarDataUris.map((entry) => [entry.userId, entry.avatarDataUri]));

    const entries: RankingsCardDisplayEntry[] = input.rankings.entries.map((entry) => {
        const member = memberById.get(entry.userId);

        return {
            ...entry,
            displayName: member?.displayName ?? `Member ${entry.userId.slice(-4)}`,
            avatarDataUri: avatarById.get(entry.userId) ?? null,
        };
    });

    const fonts = await loadCardFonts(fetchImpl);
    const element = buildRankingsCardElement({
        guildName: input.guildName,
        entries,
        totalRankedMembers: input.rankings.totalRankedMembers,
    });

    const svg = await satori(element, {
        width: RANKINGS_CARD_WIDTH,
        height: getRankingsCardHeight(entries.length),
        fonts,
    });

    return new Resvg(svg, {
        fitTo: {
            mode: 'width',
            value: RANKINGS_CARD_WIDTH,
        },
        font: {
            loadSystemFonts: false,
        },
    })
        .render()
        .asPng();
}
