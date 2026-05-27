import {
    CARD_COLORS,
    CARD_OUTER_PADDING,
    CARD_PANEL_PADDING,
    CARD_WIDTH,
} from '../shared/cardTheme';

export const RANKINGS_CARD_COLORS = CARD_COLORS;
export const RANKINGS_CARD_OUTER_PADDING = CARD_OUTER_PADDING;
export const RANKINGS_CARD_PANEL_PADDING = CARD_PANEL_PADDING;
export const RANKINGS_CARD_WIDTH = CARD_WIDTH;

export const RANKINGS_CARD_TOP_COUNT = 10;
export const RANKINGS_CARD_HEADER_HEIGHT = 56;
export const RANKINGS_CARD_TABLE_HEADER_HEIGHT = 28;
export const RANKINGS_CARD_ROW_HEIGHT = 44;
export const RANKINGS_CARD_AVATAR_SIZE = 32;
export const RANKINGS_CARD_PANEL_BOTTOM_INSET = 28;

export function getRankingsCardHeight(entryCount: number): number {
    const clampedEntries = Math.min(entryCount, RANKINGS_CARD_TOP_COUNT);

    if (clampedEntries === 0) {
        return (
            CARD_OUTER_PADDING * 2 +
            CARD_PANEL_PADDING * 2 +
            RANKINGS_CARD_HEADER_HEIGHT +
            120 +
            RANKINGS_CARD_PANEL_BOTTOM_INSET
        );
    }

    return (
        CARD_OUTER_PADDING * 2 +
        CARD_PANEL_PADDING * 2 +
        RANKINGS_CARD_HEADER_HEIGHT +
        12 +
        RANKINGS_CARD_TABLE_HEADER_HEIGHT +
        6 +
        clampedEntries * RANKINGS_CARD_ROW_HEIGHT +
        RANKINGS_CARD_PANEL_BOTTOM_INSET
    );
}
