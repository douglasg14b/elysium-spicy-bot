import { formatCalendarDate, calendarDateFromUtcMidnight } from '../../logic/warningDates';
import {
    ACTIVE_WARNINGS_CARD_AVATAR_SIZE,
    ACTIVE_WARNINGS_CARD_COLORS,
    ACTIVE_WARNINGS_CARD_HEADER_HEIGHT,
    ACTIVE_WARNINGS_CARD_OUTER_PADDING,
    ACTIVE_WARNINGS_CARD_PANEL_BOTTOM_INSET,
    ACTIVE_WARNINGS_CARD_PANEL_PADDING,
    ACTIVE_WARNINGS_CARD_ROW_HEIGHT,
    ACTIVE_WARNINGS_CARD_TABLE_HEADER_HEIGHT,
    ACTIVE_WARNINGS_CARD_WIDTH,
    getActiveWarningsCardHeight,
} from './activeWarningsCardConstants';

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

export type ActiveWarningsCardDisplayEntry = {
    slug: string;
    userId: string;
    rule: string;
    expiresAt: Date;
    displayName: string;
    avatarDataUri: string | null;
};

export type BuildActiveWarningsCardElementInput = {
    guildName: string;
    entries: ActiveWarningsCardDisplayEntry[];
    totalActive: number;
};

type TableColumn = {
    key: string;
    label: string;
    width: number;
    align?: 'left' | 'right' | 'center';
};

const TABLE_COLUMNS: readonly TableColumn[] = [
    { key: 'slug', label: 'Slug', width: 148, align: 'left' },
    { key: 'member', label: 'Member', width: 220, align: 'left' },
    { key: 'rule', label: 'Rule', width: 318, align: 'left' },
    { key: 'expires', label: 'Expires', width: 96, align: 'right' },
] as const;

function truncateText(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
        return value;
    }

    return `${value.slice(0, maxLength - 1)}…`;
}

function buildAvatar(avatarDataUri: string | null): SatoriElement {
    const size = ACTIVE_WARNINGS_CARD_AVATAR_SIZE;
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
                borderColor: ACTIVE_WARNINGS_CARD_COLORS.panelBorder,
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
            backgroundColor: ACTIVE_WARNINGS_CARD_COLORS.statChip,
            borderWidth: 2,
            borderColor: ACTIVE_WARNINGS_CARD_COLORS.panelBorder,
            borderStyle: 'solid',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            fontWeight: 700,
            color: ACTIVE_WARNINGS_CARD_COLORS.textPrimary,
            fontFamily: 'Inter',
            flexShrink: 0,
        },
        children: '?',
    });
}

function buildHeader(input: BuildActiveWarningsCardElementInput): SatoriElement {
    const hiddenCount = Math.max(0, input.totalActive - input.entries.length);
    const subtitle =
        input.totalActive === 0
            ? 'Nobody is in the doghouse'
            : hiddenCount > 0
              ? `${input.totalActive} active · ${hiddenCount} more not shown`
              : `${input.totalActive} active · soonest drop-off first`;

    return el('div', {
        style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            width: '100%',
            height: ACTIVE_WARNINGS_CARD_HEADER_HEIGHT,
            flexShrink: 0,
        },
        children: [
            el('div', {
                style: {
                    fontSize: 24,
                    fontWeight: 700,
                    color: ACTIVE_WARNINGS_CARD_COLORS.textPrimary,
                    lineHeight: 1.1,
                    fontFamily: 'Inter',
                },
                children: `Active Warnings — ${truncateText(input.guildName, 36)}`,
            }),
            el('div', {
                style: {
                    fontSize: 13,
                    color: ACTIVE_WARNINGS_CARD_COLORS.textMuted,
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
            color: ACTIVE_WARNINGS_CARD_COLORS.textMuted,
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
            height: ACTIVE_WARNINGS_CARD_TABLE_HEADER_HEIGHT,
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
            color: emphasis ? ACTIVE_WARNINGS_CARD_COLORS.textPrimary : ACTIVE_WARNINGS_CARD_COLORS.textMuted,
            fontFamily: 'Inter',
            textAlign: column.align ?? 'left',
            flexShrink: 0,
            lineHeight: 1.2,
        },
        children: content,
    });
}

function buildMemberCell(entry: ActiveWarningsCardDisplayEntry): SatoriElement {
    return el('div', {
        style: {
            width: 220,
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
                    color: ACTIVE_WARNINGS_CARD_COLORS.textPrimary,
                    fontFamily: 'Inter',
                },
                children: truncateText(entry.displayName, 18),
            }),
        ],
    });
}

function buildTableRow(entry: ActiveWarningsCardDisplayEntry): SatoriElement {
    return el('div', {
        style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            height: ACTIVE_WARNINGS_CARD_ROW_HEIGHT,
            paddingTop: 6,
            paddingBottom: 6,
            borderBottomWidth: 1,
            borderBottomColor: 'rgba(255, 255, 255, 0.06)',
            borderBottomStyle: 'solid',
            flexShrink: 0,
        },
        children: [
            buildTableCell(truncateText(entry.slug, 16), TABLE_COLUMNS[0], true),
            buildMemberCell(entry),
            buildTableCell(truncateText(entry.rule, 32), TABLE_COLUMNS[2]),
            buildTableCell(formatCalendarDate(calendarDateFromUtcMidnight(entry.expiresAt)), TABLE_COLUMNS[3], true),
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
            color: ACTIVE_WARNINGS_CARD_COLORS.textMuted,
            fontFamily: 'Inter',
            flexShrink: 0,
        },
        children: 'Nobody is in the doghouse right now.',
    });
}

export function buildActiveWarningsCardElement(input: BuildActiveWarningsCardElementInput): SatoriElement {
    const cardHeight = getActiveWarningsCardHeight(input.entries.length);

    const body =
        input.entries.length === 0
            ? buildEmptyState()
            : el('div', {
                  style: {
                      display: 'flex',
                      flexDirection: 'column',
                      width: '100%',
                      flexShrink: 0,
                      paddingBottom: ACTIVE_WARNINGS_CARD_PANEL_BOTTOM_INSET,
                  },
                  children: [buildTableHeader(), ...input.entries.map((entry) => buildTableRow(entry))],
              });

    return el('div', {
        style: {
            width: ACTIVE_WARNINGS_CARD_WIDTH,
            height: cardHeight,
            display: 'flex',
            boxSizing: 'border-box',
            padding: ACTIVE_WARNINGS_CARD_OUTER_PADDING,
            backgroundImage: `linear-gradient(135deg, ${ACTIVE_WARNINGS_CARD_COLORS.backgroundStart} 0%, ${ACTIVE_WARNINGS_CARD_COLORS.backgroundEnd} 100%)`,
            fontFamily: 'Inter',
        },
        children: el('div', {
            style: {
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                width: '100%',
                boxSizing: 'border-box',
                padding: ACTIVE_WARNINGS_CARD_PANEL_PADDING,
                borderRadius: 24,
                borderWidth: 2,
                borderColor: ACTIVE_WARNINGS_CARD_COLORS.panelBorder,
                borderStyle: 'solid',
                backgroundColor: ACTIVE_WARNINGS_CARD_COLORS.panelFill,
            },
            children: [buildHeader(input), body],
        }),
    });
}
