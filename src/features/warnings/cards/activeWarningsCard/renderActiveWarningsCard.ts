import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { fetchImageAsDataUri, loadCardFonts } from '../../../leveling/cards/shared/cardRenderAssets';
import {
    buildActiveWarningsCardElement,
    type ActiveWarningsDetailRow,
    type ActiveWarningsMemberRow,
} from './buildActiveWarningsCardElement';
import { ACTIVE_WARNINGS_CARD_WIDTH, getActiveWarningsCardHeight } from './activeWarningsCardConstants';

export type ActiveWarningsCardMember = {
    userId: string;
    displayName: string;
    avatarUrl: string | null;
};

type RenderCardShared = {
    fetchImpl?: typeof fetch;
};

export type RenderActiveWarningsCardInput = RenderCardShared &
    (
        | {
              kind: 'summary';
              guildName: string;
              summaries: Array<Omit<ActiveWarningsMemberRow, 'displayName' | 'avatarDataUri'>>;
              totalWarnings: number;
              totalMembers: number;
              members: ActiveWarningsCardMember[];
          }
        | {
              kind: 'member';
              memberName: string;
              entries: ActiveWarningsDetailRow[];
              totalActive: number;
          }
    );

export function departedWarningMemberDisplayName(userId: string): string {
    return `Left server (${userId.slice(-4)})`;
}

async function loadAvatarDataUris(
    members: ActiveWarningsCardMember[],
    fetchImpl: typeof fetch
): Promise<Map<string, string | null>> {
    const uniqueMembers = [...new Map(members.map((member) => [member.userId, member])).values()];
    const avatarDataUris = await Promise.all(
        uniqueMembers.map(async (member) => ({
            userId: member.userId,
            avatarDataUri: member.avatarUrl ? await fetchImageAsDataUri(member.avatarUrl, fetchImpl) : null,
        }))
    );

    return new Map(avatarDataUris.map((entry) => [entry.userId, entry.avatarDataUri]));
}

async function hydrateSummaryEntries(
    input: Extract<RenderActiveWarningsCardInput, { kind: 'summary' }>,
    fetchImpl: typeof fetch
): Promise<ActiveWarningsMemberRow[]> {
    const memberById = new Map(input.members.map((member) => [member.userId, member]));
    const avatarById = await loadAvatarDataUris(input.members, fetchImpl);

    return input.summaries.map((summary) => ({
        ...summary,
        displayName: memberDisplay(memberById, summary.userId),
        avatarDataUri: avatarById.get(summary.userId) ?? null,
    }));
}

function memberDisplay(members: Map<string, ActiveWarningsCardMember>, userId: string): string {
    return members.get(userId)?.displayName ?? departedWarningMemberDisplayName(userId);
}

export async function renderActiveWarningsCard(input: RenderActiveWarningsCardInput): Promise<Buffer> {
    const fetchImpl = input.fetchImpl ?? fetch;
    const element =
        input.kind === 'summary'
            ? buildActiveWarningsCardElement({
                  kind: 'summary',
                  guildName: input.guildName,
                  totalWarnings: input.totalWarnings,
                  totalMembers: input.totalMembers,
                  entries: await hydrateSummaryEntries(input, fetchImpl),
              })
            : buildActiveWarningsCardElement({
                  kind: 'member',
                  memberName: input.memberName,
                  totalActive: input.totalActive,
                  entries: input.entries,
              });

    const fonts = await loadCardFonts(fetchImpl);
    const rowCount = input.kind === 'summary' ? input.summaries.length : input.entries.length;
    const svg = await satori(element, {
        width: ACTIVE_WARNINGS_CARD_WIDTH,
        height: getActiveWarningsCardHeight(rowCount),
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
