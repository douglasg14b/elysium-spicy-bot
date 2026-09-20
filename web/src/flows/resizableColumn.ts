/**
 * Width arithmetic for a drag-resizable side column.
 *
 * Split out from the component because the interesting part is the arithmetic —
 * which way the drag runs, and where it stops — and that is testable as a pure
 * function. The DOM half is three listeners and holds no decisions.
 */

/** Inspector bounds. Narrow enough to reclaim canvas, wide enough for an embed's fields. */
export const INSPECTOR_MIN_WIDTH = 280;
export const INSPECTOR_MAX_WIDTH = 720;
export const INSPECTOR_DEFAULT_WIDTH = 320;

/**
 * Palette bounds. A shorter ceiling than the inspector's, deliberately: the palette
 * holds a list of node names, so past a point extra width buys whitespace and costs
 * canvas. The floor is where the longest block name starts truncating.
 */
export const PALETTE_MIN_WIDTH = 180;
export const PALETTE_MAX_WIDTH = 420;
export const PALETTE_DEFAULT_WIDTH = 232;

/** Where the persisted widths live. Per-browser, not per-flow: they are workspace preferences. */
export const INSPECTOR_WIDTH_STORAGE_KEY = 'brattybot.flowBuilder.inspectorWidth';
export const PALETTE_WIDTH_STORAGE_KEY = 'brattybot.flowBuilder.paletteWidth';

export interface ResizeBounds {
    readonly min: number;
    readonly max: number;
}

/**
 * Which edge of the layout a column is pinned to.
 *
 * The only thing that differs between the palette and the inspector, and it has to
 * be said explicitly because it is unguessable from inside the handle: the same
 * rightward drag widens a left-anchored column and narrows a right-anchored one.
 */
export type ColumnAnchor = 'left' | 'right';

/**
 * The width a drag has reached, clamped to its bounds.
 *
 * `delta` is the pointer's movement along the x-axis. A **right**-anchored column
 * (the inspector) grows as the pointer moves left, so its delta is subtracted; a
 * **left**-anchored one (the palette) grows as the pointer moves right. Both signs
 * live here, in one named place, rather than inline at two call sites where one of
 * them would eventually be copied wrong.
 */
export function widthFromDrag(
    startWidth: number,
    delta: number,
    bounds: ResizeBounds,
    anchor: ColumnAnchor = 'right'
): number {
    return clampWidth(anchor === 'right' ? startWidth - delta : startWidth + delta, bounds);
}

/**
 * Hold a width inside its bounds.
 *
 * Also the gate for anything restored from storage: `localStorage` is a string
 * another tab (or an older build with different bounds) may have written, so a
 * restored width is untrusted input, not a value we put there ourselves.
 */
export function clampWidth(width: number, bounds: ResizeBounds): number {
    if (width < bounds.min) return bounds.min;
    if (width > bounds.max) return bounds.max;
    return width;
}

/**
 * Read a persisted width, falling back when it is absent or unusable.
 *
 * Returns the fallback rather than throwing: a corrupt preference should cost the
 * operator their column width, not the whole builder. That is a deliberate,
 * documented degradation of a cosmetic preference — narrow enough not to hide a
 * real fault, since nothing downstream reads this value for anything else.
 */
export function readStoredWidth(raw: string | null, fallback: number, bounds: ResizeBounds): number {
    if (!raw) return fallback;

    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) return fallback;

    return clampWidth(parsed, bounds);
}
