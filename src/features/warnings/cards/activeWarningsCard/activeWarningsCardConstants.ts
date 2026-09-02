import {
    CARD_COLORS,
    CARD_OUTER_PADDING,
    CARD_PANEL_PADDING,
    CARD_WIDTH,
} from '../../../leveling/cards/shared/cardTheme';

export const ACTIVE_WARNINGS_CARD_COLORS = CARD_COLORS;
export const ACTIVE_WARNINGS_CARD_OUTER_PADDING = CARD_OUTER_PADDING;
export const ACTIVE_WARNINGS_CARD_PANEL_PADDING = CARD_PANEL_PADDING;
export const ACTIVE_WARNINGS_CARD_WIDTH = CARD_WIDTH;

export const ACTIVE_WARNINGS_CARD_HEADER_HEIGHT = 56;
export const ACTIVE_WARNINGS_CARD_TABLE_HEADER_HEIGHT = 28;
export const ACTIVE_WARNINGS_CARD_ROW_HEIGHT = 44;
export const ACTIVE_WARNINGS_CARD_AVATAR_SIZE = 32;
export const ACTIVE_WARNINGS_CARD_PANEL_BOTTOM_INSET = 28;

export function getActiveWarningsCardHeight(entryCount: number): number {
    if (entryCount === 0) {
        return (
            CARD_OUTER_PADDING * 2 +
            CARD_PANEL_PADDING * 2 +
            ACTIVE_WARNINGS_CARD_HEADER_HEIGHT +
            120 +
            ACTIVE_WARNINGS_CARD_PANEL_BOTTOM_INSET
        );
    }

    return (
        CARD_OUTER_PADDING * 2 +
        CARD_PANEL_PADDING * 2 +
        ACTIVE_WARNINGS_CARD_HEADER_HEIGHT +
        12 +
        ACTIVE_WARNINGS_CARD_TABLE_HEADER_HEIGHT +
        6 +
        entryCount * ACTIVE_WARNINGS_CARD_ROW_HEIGHT +
        ACTIVE_WARNINGS_CARD_PANEL_BOTTOM_INSET
    );
}
