import type { UserLevelProfile } from '../../logic/userLevelProfile';
import {
    LEVEL_CARD_AVATAR_BORDER,
    LEVEL_CARD_AVATAR_SIZE,
    LEVEL_CARD_COLORS,
    LEVEL_CARD_HEIGHT,
    LEVEL_CARD_OUTER_PADDING,
    LEVEL_CARD_PANEL_PADDING,
    LEVEL_CARD_WIDTH,
} from './levelCardConstants';
import { getLevelCardProgressPercent } from './levelCardProgress';

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

export type BuildLevelCardElementInput = {
    profile: UserLevelProfile;
    displayName: string;
    avatarDataUri: string | null;
};

function formatCount(value: number): string {
    return value.toLocaleString('en-US');
}

function buildAvatar(avatarDataUri: string | null): SatoriElement {
    const avatarRadius = LEVEL_CARD_AVATAR_SIZE / 2;

    if (avatarDataUri) {
        return el('img', {
            src: avatarDataUri,
            style: {
                width: LEVEL_CARD_AVATAR_SIZE,
                height: LEVEL_CARD_AVATAR_SIZE,
                borderRadius: avatarRadius,
                objectFit: 'cover',
                borderWidth: LEVEL_CARD_AVATAR_BORDER,
                borderColor: LEVEL_CARD_COLORS.accent,
                borderStyle: 'solid',
            },
        });
    }

    return el('div', {
        style: {
            width: LEVEL_CARD_AVATAR_SIZE,
            height: LEVEL_CARD_AVATAR_SIZE,
            borderRadius: avatarRadius,
            backgroundColor: LEVEL_CARD_COLORS.statChip,
            borderWidth: LEVEL_CARD_AVATAR_BORDER,
            borderColor: LEVEL_CARD_COLORS.accent,
            borderStyle: 'solid',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 56,
            fontWeight: 700,
            color: LEVEL_CARD_COLORS.textPrimary,
            fontFamily: 'Inter',
        },
        children: '?',
    });
}

function buildLevelBadge(level: number): SatoriElement {
    return el('div', {
        style: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 2,
            minWidth: 132,
            paddingTop: 14,
            paddingBottom: 14,
            paddingLeft: 20,
            paddingRight: 20,
            borderRadius: 20,
            borderWidth: 2,
            borderColor: LEVEL_CARD_COLORS.accentSoft,
            borderStyle: 'solid',
            backgroundImage: `linear-gradient(145deg, ${LEVEL_CARD_COLORS.accent} 0%, #c2185b 100%)`,
            boxShadow: '0 8px 24px rgba(232, 67, 147, 0.35)',
            flexShrink: 0,
        },
        children: [
            el('div', {
                style: {
                    fontSize: 15,
                    fontWeight: 700,
                    letterSpacing: 2.4,
                    color: 'rgba(255, 255, 255, 0.92)',
                    fontFamily: 'Inter',
                    textTransform: 'uppercase',
                },
                children: 'LVL',
            }),
            el('div', {
                style: {
                    fontSize: 56,
                    fontWeight: 700,
                    lineHeight: 1,
                    color: LEVEL_CARD_COLORS.textPrimary,
                    fontFamily: 'Inter',
                },
                children: String(level),
            }),
        ],
    });
}

function buildProgressSection(profile: UserLevelProfile): SatoriElement {
    const progressPercent = getLevelCardProgressPercent(
        profile.xpWithinLevel,
        profile.xpForCurrentLevelStep
    );

    return el('div', {
        style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            width: '100%',
        },
        children: [
            el('div', {
                style: {
                    display: 'flex',
                    width: '100%',
                    height: 24,
                    backgroundColor: LEVEL_CARD_COLORS.track,
                    borderRadius: 999,
                    overflow: 'hidden',
                },
                children: el('div', {
                    style: {
                        width: `${progressPercent}%`,
                        height: '100%',
                        backgroundImage: `linear-gradient(90deg, ${LEVEL_CARD_COLORS.accent}, ${LEVEL_CARD_COLORS.accentSoft})`,
                    },
                }),
            }),
            el('div', {
                style: {
                    display: 'flex',
                    justifyContent: 'space-between',
                    width: '100%',
                    fontSize: 14,
                    color: LEVEL_CARD_COLORS.textMuted,
                    fontFamily: 'Inter',
                },
                children: [
                    el('span', {
                        children: `${formatCount(profile.xpWithinLevel)} / ${formatCount(profile.xpForCurrentLevelStep)} XP`,
                    }),
                    el('span', {
                        children: `${formatCount(profile.xpToNextLevel)} to next level`,
                    }),
                ],
            }),
        ],
    });
}

export function buildLevelCardElement(input: BuildLevelCardElementInput): SatoriElement {
    const { profile, displayName, avatarDataUri } = input;

    return el('div', {
        style: {
            width: LEVEL_CARD_WIDTH,
            height: LEVEL_CARD_HEIGHT,
            display: 'flex',
            boxSizing: 'border-box',
            padding: LEVEL_CARD_OUTER_PADDING,
            backgroundImage: `linear-gradient(135deg, ${LEVEL_CARD_COLORS.backgroundStart} 0%, ${LEVEL_CARD_COLORS.backgroundEnd} 100%)`,
            fontFamily: 'Inter',
        },
        children: el('div', {
            style: {
                display: 'flex',
                flex: 1,
                width: '100%',
                boxSizing: 'border-box',
                padding: LEVEL_CARD_PANEL_PADDING,
                borderRadius: 24,
                borderWidth: 2,
                borderColor: LEVEL_CARD_COLORS.panelBorder,
                borderStyle: 'solid',
                backgroundColor: LEVEL_CARD_COLORS.panelFill,
                alignItems: 'center',
            },
            children: el('div', {
                style: {
                    display: 'flex',
                    gap: 28,
                    width: '100%',
                    alignItems: 'center',
                },
                children: [
                    el('div', {
                        style: {
                            display: 'flex',
                            flexShrink: 0,
                        },
                        children: buildAvatar(avatarDataUri),
                    }),
                    el('div', {
                        style: {
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 14,
                            flex: 1,
                            justifyContent: 'center',
                            minWidth: 0,
                        },
                        children: [
                            el('div', {
                                style: {
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    gap: 20,
                                    width: '100%',
                                },
                                children: [
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
                                                    fontSize: 36,
                                                    fontWeight: 700,
                                                    color: LEVEL_CARD_COLORS.textPrimary,
                                                    lineHeight: 1.1,
                                                },
                                                children: displayName,
                                            }),
                                            el('div', {
                                                style: {
                                                    fontSize: 17,
                                                    color: LEVEL_CARD_COLORS.textMuted,
                                                },
                                                children: `${formatCount(profile.totalXp)} total XP`,
                                            }),
                                        ],
                                    }),
                                    buildLevelBadge(profile.level),
                                ],
                            }),
                            buildProgressSection(profile),
                        ],
                    }),
                ],
            }),
        }),
    });
}
