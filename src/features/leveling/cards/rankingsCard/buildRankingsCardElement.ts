import type { GuildLevelRankingEntry } from '../../logic/loadGuildLevelRankings';
import { formatRelativeTime } from '../statsCard/statsCardMetrics';
import {
    getRankingsCardHeight,
    RANKINGS_CARD_AVATAR_SIZE,
    RANKINGS_CARD_COLORS,
    RANKINGS_CARD_HEADER_HEIGHT,
    RANKINGS_CARD_OUTER_PADDING,
    RANKINGS_CARD_PANEL_BOTTOM_INSET,
    RANKINGS_CARD_PANEL_PADDING,
    RANKINGS_CARD_ROW_HEIGHT,
    RANKINGS_CARD_TABLE_HEADER_HEIGHT,
    RANKINGS_CARD_WIDTH,
} from './rankingsCardConstants';

type SatoriStyle = Record<string, string | number>;
type SatoriChild = string | SatoriElement | Array<SatoriChild>;
type SatoriElement = {
    type: string;
    props: {
        style?: SatoriStyle;
        src?: string;
        children?: SatoriChild;
    };
};

function el(
    type: string,
    props: { style?: SatoriStyle; src?: string; children?: SatoriChild } = {}
): SatoriElement {
    return { type, props };
}

export type RankingsCardDisplayEntry = GuildLevelRankingEntry & {
    displayName: string;
    avatarDataUri: string | null;
};

export type BuildRankingsCardElementInput = {
    guildName: string;
    entries: RankingsCardDisplayEntry[];
    totalRankedMembers: number;
    now?: Date;
};

type TableColumn = {
    key: string;
    label: string;
    width: number;
    align?: 'left' | 'right' | 'center';
};

const TABLE_COLUMNS: readonly TableColumn[] = [
    { key: 'rank', label: '#', width: 34, align: 'center' },
    { key: 'member', label: 'Member', width: 204, align: 'left' },
    { key: 'level', label: 'Lvl', width: 44, align: 'right' },
    { key: 'totalXp', label: 'Total XP', width: 92, align: 'right' },
    { key: 'messages', label: 'Msgs', width: 58, align: 'right' },
    { key: 'reactions', label: 'Reacts', width: 62, align: 'right' },
    { key: 'photos', label: 'Photos', width: 58, align: 'right' },
    { key: 'lastActive', label: 'Last active', width: 88, align: 'right' },
] as const;

function formatCount(value: number): string {
    return value.toLocaleString('en-US');
}

function truncateName(name: string, maxLength: number): string {
    if (name.length <= maxLength) {
        return name;
    }

    return `${name.slice(0, maxLength - 1)}…`;
}

function buildAvatar(avatarDataUri: string | null): SatoriElement {
    const size = RANKINGS_CARD_AVATAR_SIZE;
    const radius = size / 2;

    if (avatarDataUri) {
        return el('img', {
            src: avatarDataUri,
            style: {
                width: size,
                height: size,
                borderRadius: radius,
                objectFit: 'cover',
                borderWidth: 2,
                borderColor: RANKINGS_CARD_COLORS.panelBorder,
                borderStyle: 'solid',
                flexShrink: 0,
            },
        });
    }

    return el('div', {
        style: {
            width: size,
            height: size,
            borderRadius: radius,
            backgroundColor: RANKINGS_CARD_COLORS.statChip,
            borderWidth: 2,
            borderColor: RANKINGS_CARD_COLORS.panelBorder,
            borderStyle: 'solid',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            fontWeight: 700,
            color: RANKINGS_CARD_COLORS.textPrimary,
            fontFamily: 'Inter',
            flexShrink: 0,
        },
        children: '?',
    });
}

function buildHeader(input: BuildRankingsCardElementInput): SatoriElement {
    const { guildName, entries, totalRankedMembers } = input;
    const subtitle =
        totalRankedMembers > 0
            ? `Top ${Math.min(entries.length, 10)} by total XP · ${formatCount(totalRankedMembers)} tracked · tie-break: oldest update first`
            : 'No tracked members yet';

    return el('div', {
        style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            width: '100%',
            height: RANKINGS_CARD_HEADER_HEIGHT,
            flexShrink: 0,
        },
        children: [
            el('div', {
                style: {
                    fontSize: 24,
                    fontWeight: 700,
                    color: RANKINGS_CARD_COLORS.textPrimary,
                    lineHeight: 1.1,
                    fontFamily: 'Inter',
                },
                children: `Level Rankings — ${truncateName(guildName, 36)}`,
            }),
            el('div', {
                style: {
                    fontSize: 13,
                    color: RANKINGS_CARD_COLORS.textMuted,
                    fontFamily: 'Inter',
                },
                children: subtitle,
            }),
        ],
    });
}

function buildTableHeaderCell(column: TableColumn): SatoriElement {
    return el('div', {
        style: {
            width: column.width,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.6,
            textTransform: 'uppercase',
            color: RANKINGS_CARD_COLORS.textMuted,
            fontFamily: 'Inter',
            textAlign: column.align ?? 'left',
            flexShrink: 0,
        },
        children: column.label,
    });
}

function buildTableHeader(): SatoriElement {
    return el('div', {
        style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            height: RANKINGS_CARD_TABLE_HEADER_HEIGHT,
            paddingBottom: 6,
            borderBottomWidth: 1,
            borderBottomColor: 'rgba(255, 255, 255, 0.12)',
            borderBottomStyle: 'solid',
            flexShrink: 0,
        },
        children: TABLE_COLUMNS.map((column) => buildTableHeaderCell(column)),
    });
}

function buildTableCell(content: string, column: TableColumn, emphasis: boolean = false): SatoriElement {
    return el('div', {
        style: {
            width: column.width,
            fontSize: 13,
            fontWeight: emphasis ? 700 : 400,
            color: emphasis ? RANKINGS_CARD_COLORS.textPrimary : RANKINGS_CARD_COLORS.textMuted,
            fontFamily: 'Inter',
            textAlign: column.align ?? 'left',
            flexShrink: 0,
            lineHeight: 1.2,
        },
        children: content,
    });
}

function buildMemberCell(entry: RankingsCardDisplayEntry): SatoriElement {
    return el('div', {
        style: {
            width: 204,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexShrink: 0,
        },
        children: [
            buildAvatar(entry.avatarDataUri),
            el('div', {
                style: {
                    fontSize: 14,
                    fontWeight: 700,
                    color: RANKINGS_CARD_COLORS.textPrimary,
                    fontFamily: 'Inter',
                },
                children: truncateName(entry.displayName, 20),
            }),
        ],
    });
}

function buildTableRow(entry: RankingsCardDisplayEntry, now: Date): SatoriElement {
    const lastActive = entry.lastActiveAt ? formatRelativeTime(entry.lastActiveAt, now) : '—';

    return el('div', {
        style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            height: RANKINGS_CARD_ROW_HEIGHT,
            paddingTop: 6,
            paddingBottom: 6,
            borderBottomWidth: 1,
            borderBottomColor: 'rgba(255, 255, 255, 0.06)',
            borderBottomStyle: 'solid',
            flexShrink: 0,
        },
        children: [
            buildTableCell(String(entry.rank), TABLE_COLUMNS[0], true),
            buildMemberCell(entry),
            buildTableCell(String(entry.level), TABLE_COLUMNS[2]),
            buildTableCell(formatCount(entry.totalXp), TABLE_COLUMNS[3], true),
            buildTableCell(formatCount(entry.messageCount), TABLE_COLUMNS[4]),
            buildTableCell(formatCount(entry.reactionCount), TABLE_COLUMNS[5]),
            buildTableCell(formatCount(entry.photoUploadCount), TABLE_COLUMNS[6]),
            buildTableCell(lastActive, TABLE_COLUMNS[7]),
        ],
    });
}

function buildEmptyState(): SatoriElement {
    return el('div', {
        style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            height: 120,
            fontSize: 15,
            color: RANKINGS_CARD_COLORS.textMuted,
            fontFamily: 'Inter',
            flexShrink: 0,
        },
        children: 'No ranked members in this server yet.',
    });
}

export function buildRankingsCardElement(input: BuildRankingsCardElementInput): SatoriElement {
    const now = input.now ?? new Date();
    const cardHeight = getRankingsCardHeight(input.entries.length);

    const body =
        input.entries.length === 0
            ? buildEmptyState()
            : el('div', {
                  style: {
                      display: 'flex',
                      flexDirection: 'column',
                      width: '100%',
                      flexShrink: 0,
                      paddingBottom: RANKINGS_CARD_PANEL_BOTTOM_INSET,
                  },
                  children: [
                      buildTableHeader(),
                      ...input.entries.map((entry) => buildTableRow(entry, now)),
                  ],
              });

    return el('div', {
        style: {
            width: RANKINGS_CARD_WIDTH,
            height: cardHeight,
            display: 'flex',
            boxSizing: 'border-box',
            padding: RANKINGS_CARD_OUTER_PADDING,
            backgroundImage: `linear-gradient(135deg, ${RANKINGS_CARD_COLORS.backgroundStart} 0%, ${RANKINGS_CARD_COLORS.backgroundEnd} 100%)`,
            fontFamily: 'Inter',
        },
        children: el('div', {
            style: {
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                width: '100%',
                boxSizing: 'border-box',
                padding: RANKINGS_CARD_PANEL_PADDING,
                borderRadius: 24,
                borderWidth: 2,
                borderColor: RANKINGS_CARD_COLORS.panelBorder,
                borderStyle: 'solid',
                backgroundColor: RANKINGS_CARD_COLORS.panelFill,
            },
            children: [buildHeader(input), body],
        }),
    });
}
