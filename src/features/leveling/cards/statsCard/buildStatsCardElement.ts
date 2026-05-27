import type { DailyActivityBucket } from '../../data/levelingActivityEventSchema';
import type { UserLevelStats } from '../../logic/loadUserLevelStats';
import {
    formatActivityStatus,
    formatRelativeTime,
    formatShortDate,
    type ActivityStatus,
} from './statsCardMetrics';
import {
    STATS_CARD_AVATAR_BORDER,
    STATS_CARD_AVATAR_SIZE,
    STATS_CARD_CHART_BAR_MAX_HEIGHT,
    STATS_CARD_CHART_BAR_WIDTH,
    STATS_CARD_COLORS,
    STATS_CARD_HEIGHT,
    STATS_CARD_MIDDLE_SECTION_HEIGHT,
    STATS_CARD_OUTER_PADDING,
    STATS_CARD_PANEL_BOTTOM_INSET,
    STATS_CARD_PANEL_PADDING,
    STATS_CARD_STATUS_COLORS,
    STATS_CARD_WIDTH,
} from './statsCardConstants';

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

export type BuildStatsCardElementInput = UserLevelStats & {
    displayName: string;
    avatarDataUri: string | null;
    now?: Date;
};

function formatCount(value: number): string {
    return value.toLocaleString('en-US');
}

function formatDecimal(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function buildAvatar(avatarDataUri: string | null): SatoriElement {
    const avatarRadius = STATS_CARD_AVATAR_SIZE / 2;

    if (avatarDataUri) {
        return el('img', {
            src: avatarDataUri,
            style: {
                width: STATS_CARD_AVATAR_SIZE,
                height: STATS_CARD_AVATAR_SIZE,
                borderRadius: avatarRadius,
                objectFit: 'cover',
                borderWidth: STATS_CARD_AVATAR_BORDER,
                borderColor: STATS_CARD_COLORS.accent,
                borderStyle: 'solid',
            },
        });
    }

    return el('div', {
        style: {
            width: STATS_CARD_AVATAR_SIZE,
            height: STATS_CARD_AVATAR_SIZE,
            borderRadius: avatarRadius,
            backgroundColor: STATS_CARD_COLORS.statChip,
            borderWidth: STATS_CARD_AVATAR_BORDER,
            borderColor: STATS_CARD_COLORS.accent,
            borderStyle: 'solid',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 32,
            fontWeight: 700,
            color: STATS_CARD_COLORS.textPrimary,
            fontFamily: 'Inter',
        },
        children: '?',
    });
}

function buildStatusPill(status: ActivityStatus): SatoriElement {
    const color = STATS_CARD_STATUS_COLORS[status];

    return el('div', {
        style: {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            paddingTop: 4,
            paddingBottom: 4,
            paddingLeft: 10,
            paddingRight: 10,
            borderRadius: 999,
            backgroundColor: `${color}22`,
            borderWidth: 1,
            borderColor: `${color}66`,
            borderStyle: 'solid',
        },
        children: [
            el('div', {
                style: {
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: color,
                },
            }),
            el('div', {
                style: {
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: 0.6,
                    textTransform: 'uppercase',
                    color,
                    fontFamily: 'Inter',
                },
                children: formatActivityStatus(status),
            }),
        ],
    });
}

function buildHeroStat(label: string, value: string, accent?: string): SatoriElement {
    return el('div', {
        style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            flex: 1,
            paddingTop: 14,
            paddingBottom: 14,
            paddingLeft: 16,
            paddingRight: 16,
            borderRadius: 14,
            backgroundColor: STATS_CARD_COLORS.statChip,
            borderWidth: 1,
            borderColor: 'rgba(255, 255, 255, 0.08)',
            borderStyle: 'solid',
        },
        children: [
            el('div', {
                style: {
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: 0.8,
                    textTransform: 'uppercase',
                    color: STATS_CARD_COLORS.textMuted,
                    fontFamily: 'Inter',
                },
                children: label,
            }),
            el('div', {
                style: {
                    fontSize: 28,
                    fontWeight: 700,
                    color: accent ?? STATS_CARD_COLORS.textPrimary,
                    fontFamily: 'Inter',
                    lineHeight: 1,
                },
                children: value,
            }),
        ],
    });
}

function buildSectionTitle(label: string): SatoriElement {
    return el('div', {
        style: {
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: 0.8,
            textTransform: 'uppercase',
            color: STATS_CARD_COLORS.accentSoft,
            fontFamily: 'Inter',
            flexShrink: 0,
        },
        children: label,
    });
}

function buildPanelBox(children: SatoriChild): SatoriElement {
    return el('div', {
        style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            width: '100%',
            height: STATS_CARD_MIDDLE_SECTION_HEIGHT,
            boxSizing: 'border-box',
            paddingTop: 12,
            paddingBottom: 12,
            paddingLeft: 14,
            paddingRight: 14,
            borderRadius: 16,
            backgroundColor: STATS_CARD_COLORS.statChip,
            borderWidth: 1,
            borderColor: 'rgba(255, 255, 255, 0.08)',
            borderStyle: 'solid',
            flexShrink: 0,
        },
        children,
    });
}

function buildDailyChart(dailyActivity: DailyActivityBucket[], peakEvents: number): SatoriElement {
    const barMaxHeight = STATS_CARD_CHART_BAR_MAX_HEIGHT;
    const barWidth = STATS_CARD_CHART_BAR_WIDTH;
    const chartHeight = barMaxHeight + 14;

    return el('div', {
        style: {
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 6,
            width: '100%',
            height: chartHeight,
            flexShrink: 0,
        },
        children: dailyActivity.map((day) => {
            const eventCount = day.messageCount + day.reactionCount;
            const height =
                peakEvents > 0 ? Math.max(4, Math.round((eventCount / peakEvents) * barMaxHeight)) : 4;
            const dayLabel = day.activityDate.slice(8);

            return el('div', {
                style: {
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    gap: 4,
                    flex: 1,
                },
                children: [
                    el('div', {
                        style: {
                            width: barWidth,
                            height,
                            borderRadius: 6,
                            ...(eventCount > 0
                                ? {
                                      backgroundImage: `linear-gradient(180deg, ${STATS_CARD_COLORS.accentSoft}, ${STATS_CARD_COLORS.accent})`,
                                  }
                                : {
                                      backgroundColor: STATS_CARD_COLORS.track,
                                  }),
                        },
                    }),
                    el('div', {
                        style: {
                            fontSize: 10,
                            color: STATS_CARD_COLORS.textMuted,
                            fontFamily: 'Inter',
                            flexShrink: 0,
                        },
                        children: dayLabel,
                    }),
                ],
            });
        }),
    });
}

function buildMixBar(messagePercent: number, reactionPercent: number): SatoriElement {
    const segments: SatoriElement[] = [];

    if (messagePercent > 0) {
        segments.push(
            el('div', {
                style: {
                    width: `${messagePercent}%`,
                    height: '100%',
                    backgroundColor: STATS_CARD_COLORS.accent,
                },
            })
        );
    }

    if (reactionPercent > 0) {
        segments.push(
            el('div', {
                style: {
                    width: `${reactionPercent}%`,
                    height: '100%',
                    backgroundColor: STATS_CARD_COLORS.accentSoft,
                },
            })
        );
    }

    return el('div', {
        style: {
            display: 'flex',
            width: '100%',
            height: 12,
            borderRadius: 999,
            overflow: 'hidden',
            backgroundColor: STATS_CARD_COLORS.track,
        },
        children: segments,
    });
}

function buildInsightTile(label: string, value: string): SatoriElement {
    return el('div', {
        style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            flex: 1,
            minWidth: 0,
        },
        children: [
            el('div', {
                style: {
                    fontSize: 11,
                    color: STATS_CARD_COLORS.textMuted,
                    fontFamily: 'Inter',
                },
                children: label,
            }),
            el('div', {
                style: {
                    fontSize: 14,
                    fontWeight: 700,
                    color: STATS_CARD_COLORS.textPrimary,
                    fontFamily: 'Inter',
                },
                children: value,
            }),
        ],
    });
}

function buildMetaLine(input: BuildStatsCardElementInput): string {
    const { metrics, now = new Date() } = input;
    const parts: string[] = [];

    if (metrics.lastActiveAt) {
        parts.push(`Last active ${formatRelativeTime(metrics.lastActiveAt, now)}`);
    } else {
        parts.push('No recent XP activity');
    }

    if (metrics.memberSince) {
        parts.push(`Tracking since ${formatShortDate(metrics.memberSince)}`);
    }

    parts.push(`${metrics.tenureDays}d on record`);

    return parts.join(' · ');
}

function buildEmptyState(): SatoriElement {
    return el('div', {
        style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            paddingTop: 24,
            paddingBottom: 24,
            alignItems: 'center',
            justifyContent: 'center',
            flex: 1,
        },
        children: [
            el('div', {
                style: {
                    fontSize: 20,
                    fontWeight: 700,
                    color: STATS_CARD_COLORS.textPrimary,
                    fontFamily: 'Inter',
                },
                children: 'No tracked activity yet',
            }),
            el('div', {
                style: {
                    fontSize: 15,
                    color: STATS_CARD_COLORS.textMuted,
                    fontFamily: 'Inter',
                    textAlign: 'center',
                    lineHeight: 1.4,
                    maxWidth: 520,
                },
                children:
                    'Messages, reactions, and photo bonuses will populate this card once this member earns XP.',
            }),
        ],
    });
}

function buildActiveBody(input: BuildStatsCardElementInput): SatoriElement {
    const { profile, dailyActivity, metrics } = input;
    const { recentActivity, recentPeriodDays } = profile;

    return el('div', {
        style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            width: '100%',
            flexShrink: 0,
            paddingBottom: STATS_CARD_PANEL_BOTTOM_INSET,
        },
        children: [
            el('div', {
                style: {
                    display: 'flex',
                    gap: 12,
                    width: '100%',
                    flexShrink: 0,
                },
                children: [
                    buildHeroStat('Messages', formatCount(recentActivity.messageCount)),
                    buildHeroStat('Reactions', formatCount(recentActivity.reactionCount)),
                    buildHeroStat('Photos', formatCount(recentActivity.photoUploadCount)),
                    buildHeroStat(
                        'XP (recent)',
                        formatCount(recentActivity.totalXp),
                        STATS_CARD_COLORS.accentSoft
                    ),
                ],
            }),
            el('div', {
                style: {
                    display: 'flex',
                    gap: 14,
                    width: '100%',
                    flexShrink: 0,
                },
                children: [
                    el('div', {
                        style: {
                            display: 'flex',
                            flexDirection: 'column',
                            flex: 1,
                            minWidth: 0,
                        },
                        children: buildPanelBox([
                            buildSectionTitle(`Activity trend (${recentPeriodDays}d)`),
                            buildDailyChart(dailyActivity, metrics.dailyPeakEvents),
                        ]),
                    }),
                    el('div', {
                        style: {
                            display: 'flex',
                            flexDirection: 'column',
                            flex: 1,
                            minWidth: 0,
                        },
                        children: buildPanelBox([
                        buildSectionTitle('Engagement mix'),
                        buildMixBar(metrics.messageSharePercent, metrics.reactionSharePercent),
                        el('div', {
                            style: {
                                display: 'flex',
                                justifyContent: 'space-between',
                                fontSize: 11,
                                color: STATS_CARD_COLORS.textMuted,
                                fontFamily: 'Inter',
                                flexShrink: 0,
                            },
                            children: [
                                el('span', {
                                    children: `Messages ${metrics.messageSharePercent}%`,
                                }),
                                el('span', {
                                    children: `Reactions ${metrics.reactionSharePercent}%`,
                                }),
                            ],
                        }),
                        el('div', {
                            style: {
                                display: 'flex',
                                gap: 10,
                                width: '100%',
                                flexShrink: 0,
                            },
                            children: [
                                buildInsightTile('Msgs / day', formatDecimal(metrics.recentMsgsPerDay)),
                                buildInsightTile('XP / day', formatDecimal(metrics.recentXpPerDay)),
                            ],
                        }),
                        el('div', {
                            style: {
                                display: 'flex',
                                gap: 10,
                                width: '100%',
                                flexShrink: 0,
                            },
                            children: [
                                buildInsightTile(
                                    'Avg msg length',
                                    metrics.avgMessageLengthRecent != null
                                        ? `${formatCount(metrics.avgMessageLengthRecent)} chars`
                                        : '—'
                                ),
                                buildInsightTile(
                                    'Photo rate',
                                    recentActivity.messageCount > 0
                                        ? `${metrics.photoRatePercent}%`
                                        : '—'
                                ),
                            ],
                        }),
                        ]),
                    }),
                ],
            }),
        ],
    });
}

export function buildStatsCardElement(input: BuildStatsCardElementInput): SatoriElement {
    const { profile, displayName, avatarDataUri } = input;

    return el('div', {
        style: {
            width: STATS_CARD_WIDTH,
            height: STATS_CARD_HEIGHT,
            display: 'flex',
            boxSizing: 'border-box',
            padding: STATS_CARD_OUTER_PADDING,
            backgroundImage: `linear-gradient(135deg, ${STATS_CARD_COLORS.backgroundStart} 0%, ${STATS_CARD_COLORS.backgroundEnd} 100%)`,
            fontFamily: 'Inter',
        },
        children: el('div', {
            style: {
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
                width: '100%',
                boxSizing: 'border-box',
                padding: STATS_CARD_PANEL_PADDING,
                borderRadius: 24,
                borderWidth: 2,
                borderColor: STATS_CARD_COLORS.panelBorder,
                borderStyle: 'solid',
                backgroundColor: STATS_CARD_COLORS.panelFill,
            },
            children: [
                el('div', {
                    style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: 16,
                        width: '100%',
                    },
                    children: [
                        buildAvatar(avatarDataUri),
                        el('div', {
                            style: {
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 6,
                                flex: 1,
                                minWidth: 0,
                            },
                            children: [
                                el('div', {
                                    style: {
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 12,
                                    },
                                    children: [
                                        el('div', {
                                            style: {
                                                fontSize: 28,
                                                fontWeight: 700,
                                                color: STATS_CARD_COLORS.textPrimary,
                                                lineHeight: 1.1,
                                            },
                                            children: displayName,
                                        }),
                                        buildStatusPill(input.metrics.activityStatus),
                                    ],
                                }),
                                el('div', {
                                    style: {
                                        fontSize: 14,
                                        color: STATS_CARD_COLORS.textMuted,
                                        lineHeight: 1.3,
                                    },
                                    children: buildMetaLine(input),
                                }),
                            ],
                        }),
                        el('div', {
                            style: {
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'flex-end',
                                gap: 2,
                                flexShrink: 0,
                            },
                            children: [
                                el('div', {
                                    style: {
                                        fontSize: 13,
                                        fontWeight: 700,
                                        letterSpacing: 1,
                                        textTransform: 'uppercase',
                                        color: STATS_CARD_COLORS.accentSoft,
                                    },
                                    children: `Level ${profile.level}`,
                                }),
                                el('div', {
                                    style: {
                                        fontSize: 22,
                                        fontWeight: 700,
                                        color: STATS_CARD_COLORS.textPrimary,
                                    },
                                    children: `${formatCount(profile.totalXp)} XP`,
                                }),
                            ],
                        }),
                    ],
                }),
                profile.hasAnyActivity ? buildActiveBody(input) : buildEmptyState(),
            ],
        }),
    });
}
