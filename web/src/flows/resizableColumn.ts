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

/** Where the persisted width lives. Per-browser, not per-flow: it is a workspace preference. */
export const INSPECTOR_WIDTH_STORAGE_KEY = 'brattybot.flowBuilder.inspectorWidth';

export interface ResizeBounds {
    readonly min: number;
    readonly max: number;
}

/**
 * The width a drag has reached, clamped to its bounds.
 *
 * `delta` is the pointer's movement along the x-axis. The inspector is anchored
 * to the **right** edge, so dragging left (a negative delta) makes it *wider* —
 * hence the subtraction. A left-anchored column would add, which is why the sign
 * lives here in one named place rather than inline at the call site.
 */
export function widthFromDrag(startWidth: number, delta: number, bounds: ResizeBounds): number {
    return clampWidth(startWidth - delta, bounds);
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
