import {
    CARD_COLORS,
    CARD_OUTER_PADDING,
    CARD_PANEL_PADDING,
    CARD_WIDTH,
} from '../shared/cardTheme';

export const STATS_CARD_COLORS = CARD_COLORS;
export const STATS_CARD_OUTER_PADDING = CARD_OUTER_PADDING;
export const STATS_CARD_PANEL_PADDING = CARD_PANEL_PADDING;
export const STATS_CARD_WIDTH = CARD_WIDTH;

export const STATS_CARD_AVATAR_SIZE = 80;
export const STATS_CARD_AVATAR_BORDER = 3;

/** Fixed height for the chart + engagement mix row so panels stay inside the border. */
export const STATS_CARD_MIDDLE_SECTION_HEIGHT = 188;
export const STATS_CARD_CHART_BAR_MAX_HEIGHT = 112;
export const STATS_CARD_CHART_BAR_WIDTH = 34;

/** Breathing room between the bottom panels and the inner panel border. */
export const STATS_CARD_PANEL_BOTTOM_INSET = 28;

/**
 * Derived from section heights — avoids flex growth leaving panels flush with the frame.
 * header + hero + middle panels + gaps + inset + panel/outer padding.
 */
export const STATS_CARD_HEIGHT =
    CARD_OUTER_PADDING * 2 +
    CARD_PANEL_PADDING * 2 +
    80 +
    58 +
    STATS_CARD_MIDDLE_SECTION_HEIGHT +
    14 * 2 +
    STATS_CARD_PANEL_BOTTOM_INSET;

export const STATS_CARD_STATUS_COLORS = {
    active: '#4ade80',
    quiet: '#fbbf24',
    dormant: '#f87171',
    none: '#94a3b8',
} as const;
