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

export type ActiveWarningsMemberRow = {
    userId: string;
    warningCount: number;
    soonestExpiresAt: Date;
    displayName: string;
    avatarDataUri: string | null;
};

export type ActiveWarningsDetailRow = {
    slug: string;
    rule: string;
    expiresAt: Date;
};

export type BuildActiveWarningsCardElementInput =
    | {
          kind: 'summary';
          guildName: string;
          entries: ActiveWarningsMemberRow[];
          totalWarnings: number;
          totalMembers: number;
      }
    | {
          kind: 'member';
          memberName: string;
          entries: ActiveWarningsDetailRow[];
          totalActive: number;
      };

type TableColumn = {
    key: string;
    label: string;
    width: number;
    align?: 'left' | 'right' | 'center';
};

const SUMMARY_COLUMNS: readonly TableColumn[] = [
    { key: 'member', label: 'Member', width: 420, align: 'left' },
    { key: 'count', label: 'Warnings', width: 110, align: 'right' },
    { key: 'expires', label: 'Next drop-off', width: 250, align: 'right' },
] as const;

const MEMBER_COLUMNS: readonly TableColumn[] = [
    { key: 'slug', label: 'Slug', width: 180, align: 'left' },
    { key: 'rule', label: 'Rule', width: 430, align: 'left' },
    { key: 'expires', label: 'Expires', width: 170, align: 'right' },
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

function buildHeader(title: string, subtitle: string): SatoriElement {
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
                children: title,
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

function summarySubtitle(input: Extract<BuildActiveWarningsCardElementInput, { kind: 'summary' }>): string {
    if (input.totalWarnings === 0) {
        return 'Nobody is in the doghouse';
    }

    const hiddenMembers = Math.max(0, input.totalMembers - input.entries.length);
    const counts = `${input.totalWarnings} active · ${input.totalMembers} members`;

    return hiddenMembers > 0 ? `${counts} · ${hiddenMembers} more not shown` : counts;
}

function memberSubtitle(input: Extract<BuildActiveWarningsCardElementInput, { kind: 'member' }>): string {
    if (input.totalActive === 0) {
        return 'No active warnings';
    }

    const hiddenCount = Math.max(0, input.totalActive - input.entries.length);
    return hiddenCount > 0
        ? `${input.totalActive} active · ${hiddenCount} more not shown`
        : `${input.totalActive} active · soonest drop-off first`;
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

function buildTableHeader(columns: readonly TableColumn[]): SatoriElement {
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
        children: columns.map((column) => buildTableHeaderCell(column)),
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

function buildMemberCell(displayName: string, avatarDataUri: string | null, width: number): SatoriElement {
    return el('div', {
        style: {
            width,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexShrink: 0,
        },
        children: [
            buildAvatar(avatarDataUri),
            el('div', {
                style: {
                    fontSize: 14,
                    fontWeight: 700,
                    color: ACTIVE_WARNINGS_CARD_COLORS.textPrimary,
                    fontFamily: 'Inter',
                },
                children: truncateText(displayName, 28),
            }),
        ],
    });
}

function buildRow(children: SatoriElement[]): SatoriElement {
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
        children,
    });
}

function buildSummaryRow(entry: ActiveWarningsMemberRow): SatoriElement {
    return buildRow([
        buildMemberCell(entry.displayName, entry.avatarDataUri, SUMMARY_COLUMNS[0].width),
        buildTableCell(String(entry.warningCount), SUMMARY_COLUMNS[1], true),
        buildTableCell(
            formatCalendarDate(calendarDateFromUtcMidnight(entry.soonestExpiresAt)),
            SUMMARY_COLUMNS[2],
            true
        ),
    ]);
}

function buildDetailRow(entry: ActiveWarningsDetailRow): SatoriElement {
    return buildRow([
        buildTableCell(truncateText(entry.slug, 20), MEMBER_COLUMNS[0], true),
        buildTableCell(truncateText(entry.rule, 42), MEMBER_COLUMNS[1]),
        buildTableCell(formatCalendarDate(calendarDateFromUtcMidnight(entry.expiresAt)), MEMBER_COLUMNS[2], true),
    ]);
}

function buildEmptyState(message: string): SatoriElement {
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
        children: message,
    });
}

function headerFor(input: BuildActiveWarningsCardElementInput): { title: string; subtitle: string } {
    if (input.kind === 'summary') {
        return {
            title: `Active Warnings — ${truncateText(input.guildName, 36)}`,
            subtitle: summarySubtitle(input),
        };
    }

    return {
        title: `Active Warnings — ${truncateText(input.memberName, 36)}`,
        subtitle: memberSubtitle(input),
    };
}

export function buildActiveWarningsCardElement(input: BuildActiveWarningsCardElementInput): SatoriElement {
    const cardHeight = getActiveWarningsCardHeight(input.entries.length);
    const { title, subtitle } = headerFor(input);

    const body =
        input.entries.length === 0
            ? buildEmptyState(
                  input.kind === 'summary'
                      ? 'Nobody is in the doghouse right now.'
                      : "They're clean. For now."
              )
            : el('div', {
                  style: {
                      display: 'flex',
                      flexDirection: 'column',
                      width: '100%',
                      flexShrink: 0,
                      paddingBottom: ACTIVE_WARNINGS_CARD_PANEL_BOTTOM_INSET,
                  },
                  children:
                      input.kind === 'summary'
                          ? [buildTableHeader(SUMMARY_COLUMNS), ...input.entries.map((entry) => buildSummaryRow(entry))]
                          : [buildTableHeader(MEMBER_COLUMNS), ...input.entries.map((entry) => buildDetailRow(entry))],
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
            children: [buildHeader(title, subtitle), body],
        }),
    });
}
