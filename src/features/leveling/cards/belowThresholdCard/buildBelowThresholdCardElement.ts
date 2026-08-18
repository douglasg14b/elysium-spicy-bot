import {
    formatThresholdLabel,
    type BelowThresholdReport,
    type BelowThresholdReportEntry,
} from '../../logic/belowThresholdReport';
import { formatRelativeTime } from '../statsCard/statsCardMetrics';
import {
    BELOW_THRESHOLD_CARD_AVATAR_SIZE,
    BELOW_THRESHOLD_CARD_COLORS,
    BELOW_THRESHOLD_CARD_HEADER_HEIGHT,
    BELOW_THRESHOLD_CARD_OUTER_PADDING,
    BELOW_THRESHOLD_CARD_PANEL_BOTTOM_INSET,
    BELOW_THRESHOLD_CARD_PANEL_PADDING,
    BELOW_THRESHOLD_CARD_ROW_HEIGHT,
    BELOW_THRESHOLD_CARD_TABLE_HEADER_HEIGHT,
    BELOW_THRESHOLD_CARD_WIDTH,
    getBelowThresholdCardHeight,
} from './belowThresholdCardConstants';

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

export type BelowThresholdCardDisplayEntry = BelowThresholdReportEntry & {
    rank: number;
    avatarDataUri: string | null;
};

export type BuildBelowThresholdCardElementInput = {
    guildName: string;
    report: Pick<BelowThresholdReport, 'filter' | 'totalConsidered' | 'entries'>;
    cardEntries: BelowThresholdCardDisplayEntry[];
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
    { key: 'toGo', label: 'To go', width: 72, align: 'right' },
    { key: 'messages', label: 'Msgs', width: 58, align: 'right' },
    { key: 'reactions', label: 'Reacts', width: 62, align: 'right' },
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
    const size = BELOW_THRESHOLD_CARD_AVATAR_SIZE;
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
                borderColor: BELOW_THRESHOLD_CARD_COLORS.panelBorder,
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
            backgroundColor: BELOW_THRESHOLD_CARD_COLORS.statChip,
            borderWidth: 2,
            borderColor: BELOW_THRESHOLD_CARD_COLORS.panelBorder,
            borderStyle: 'solid',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            fontWeight: 700,
            color: BELOW_THRESHOLD_CARD_COLORS.textPrimary,
            fontFamily: 'Inter',
            flexShrink: 0,
        },
        children: '?',
    });
}

function buildHeader(input: BuildBelowThresholdCardElementInput): SatoriElement {
    const { guildName, report, cardEntries } = input;
    const threshold = formatThresholdLabel(report.filter);
    const scopeLabel = report.filter.scope === 'current' ? 'current members' : 'tracked members';
    const subtitle =
        report.entries.length === 0
            ? `Nobody is ${threshold} among ${scopeLabel}`
            : `${formatCount(report.entries.length)} of ${formatCount(report.totalConsidered)} ${scopeLabel} ${threshold} · showing ${cardEntries.length} closest`;

    return el('div', {
        style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            width: '100%',
            height: BELOW_THRESHOLD_CARD_HEADER_HEIGHT,
            flexShrink: 0,
        },
        children: [
            el('div', {
                style: {
                    fontSize: 24,
                    fontWeight: 700,
                    color: BELOW_THRESHOLD_CARD_COLORS.textPrimary,
                    lineHeight: 1.1,
                    fontFamily: 'Inter',
                },
                children: `Below Threshold — ${truncateName(guildName, 28)}`,
            }),
            el('div', {
                style: {
                    fontSize: 13,
                    color: BELOW_THRESHOLD_CARD_COLORS.textMuted,
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
            color: BELOW_THRESHOLD_CARD_COLORS.textMuted,
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
            height: BELOW_THRESHOLD_CARD_TABLE_HEADER_HEIGHT,
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
            color: emphasis ? BELOW_THRESHOLD_CARD_COLORS.textPrimary : BELOW_THRESHOLD_CARD_COLORS.textMuted,
            fontFamily: 'Inter',
            textAlign: column.align ?? 'left',
            flexShrink: 0,
            lineHeight: 1.2,
        },
        children: content,
    });
}

function buildMemberCell(entry: BelowThresholdCardDisplayEntry): SatoriElement {
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
                    color: BELOW_THRESHOLD_CARD_COLORS.textPrimary,
                    fontFamily: 'Inter',
                },
                children: truncateName(entry.displayName, 20),
            }),
        ],
    });
}

function buildTableRow(entry: BelowThresholdCardDisplayEntry, now: Date): SatoriElement {
    const lastActive = entry.lastActiveAt
        ? formatRelativeTime(entry.lastActiveAt, now, { alwaysRelative: true })
        : '—';

    return el('div', {
        style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            height: BELOW_THRESHOLD_CARD_ROW_HEIGHT,
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
            buildTableCell(formatCount(entry.xpToThreshold), TABLE_COLUMNS[4], true),
            buildTableCell(formatCount(entry.messageCount), TABLE_COLUMNS[5]),
            buildTableCell(formatCount(entry.reactionCount), TABLE_COLUMNS[6]),
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
            color: BELOW_THRESHOLD_CARD_COLORS.textMuted,
            fontFamily: 'Inter',
            flexShrink: 0,
        },
        children: 'Everyone is at or above this threshold.',
    });
}

export function buildBelowThresholdCardElement(input: BuildBelowThresholdCardElementInput): SatoriElement {
    const now = input.now ?? new Date();
    const cardHeight = getBelowThresholdCardHeight(input.cardEntries.length);

    const body =
        input.cardEntries.length === 0
            ? buildEmptyState()
            : el('div', {
                  style: {
                      display: 'flex',
                      flexDirection: 'column',
                      width: '100%',
                      flexShrink: 0,
                      paddingBottom: BELOW_THRESHOLD_CARD_PANEL_BOTTOM_INSET,
                  },
                  children: [
                      buildTableHeader(),
                      ...input.cardEntries.map((entry) => buildTableRow(entry, now)),
                  ],
              });

    return el('div', {
        style: {
            width: BELOW_THRESHOLD_CARD_WIDTH,
            height: cardHeight,
            display: 'flex',
            boxSizing: 'border-box',
            padding: BELOW_THRESHOLD_CARD_OUTER_PADDING,
            backgroundImage: `linear-gradient(135deg, ${BELOW_THRESHOLD_CARD_COLORS.backgroundStart} 0%, ${BELOW_THRESHOLD_CARD_COLORS.backgroundEnd} 100%)`,
            fontFamily: 'Inter',
        },
        children: el('div', {
            style: {
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                width: '100%',
                boxSizing: 'border-box',
                padding: BELOW_THRESHOLD_CARD_PANEL_PADDING,
                borderRadius: 24,
                borderWidth: 2,
                borderColor: BELOW_THRESHOLD_CARD_COLORS.panelBorder,
                borderStyle: 'solid',
                backgroundColor: BELOW_THRESHOLD_CARD_COLORS.panelFill,
            },
            children: [buildHeader(input), body],
        }),
    });
}
