import {
    CARD_COLORS,
    CARD_OUTER_PADDING,
    CARD_PANEL_PADDING,
    CARD_WIDTH,
} from '../shared/cardTheme';
import { BELOW_THRESHOLD_CARD_ROW_LIMIT } from '../../logic/belowThresholdReport';

export const BELOW_THRESHOLD_CARD_COLORS = CARD_COLORS;
export const BELOW_THRESHOLD_CARD_OUTER_PADDING = CARD_OUTER_PADDING;
export const BELOW_THRESHOLD_CARD_PANEL_PADDING = CARD_PANEL_PADDING;
export const BELOW_THRESHOLD_CARD_WIDTH = CARD_WIDTH;

export const BELOW_THRESHOLD_CARD_HEADER_HEIGHT = 56;
export const BELOW_THRESHOLD_CARD_TABLE_HEADER_HEIGHT = 28;
export const BELOW_THRESHOLD_CARD_ROW_HEIGHT = 44;
export const BELOW_THRESHOLD_CARD_AVATAR_SIZE = 32;
export const BELOW_THRESHOLD_CARD_PANEL_BOTTOM_INSET = 28;

export function getBelowThresholdCardHeight(entryCount: number): number {
    const clampedEntries = Math.min(entryCount, BELOW_THRESHOLD_CARD_ROW_LIMIT);

    if (clampedEntries === 0) {
        return (
            CARD_OUTER_PADDING * 2 +
            CARD_PANEL_PADDING * 2 +
            BELOW_THRESHOLD_CARD_HEADER_HEIGHT +
            120 +
            BELOW_THRESHOLD_CARD_PANEL_BOTTOM_INSET
        );
    }

    return (
        CARD_OUTER_PADDING * 2 +
        CARD_PANEL_PADDING * 2 +
        BELOW_THRESHOLD_CARD_HEADER_HEIGHT +
        12 +
        BELOW_THRESHOLD_CARD_TABLE_HEADER_HEIGHT +
        6 +
        clampedEntries * BELOW_THRESHOLD_CARD_ROW_HEIGHT +
        BELOW_THRESHOLD_CARD_PANEL_BOTTOM_INSET
    );
}
