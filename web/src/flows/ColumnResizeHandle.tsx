import { useCallback, useEffect, useRef, useState } from 'react';
import {
    INSPECTOR_MAX_WIDTH,
    INSPECTOR_MIN_WIDTH,
    widthFromDrag,
    type ColumnAnchor,
    type ResizeBounds,
} from './resizableColumn';

interface ColumnResizeHandleProps {
    /** The column's width right now, used as the drag's origin. */
    width: number;
    onResize: (width: number) => void;
    bounds?: ResizeBounds;
    /** Which edge the column is pinned to. Decides which way a drag widens it. */
    anchor?: ColumnAnchor;
    /** Announced to screen readers, e.g. "inspector width". */
    label: string;
}

const DEFAULT_BOUNDS: ResizeBounds = { min: INSPECTOR_MIN_WIDTH, max: INSPECTOR_MAX_WIDTH };

/** How far one arrow-key press moves the edge. */
const KEYBOARD_STEP = 16;

/**
 * The grab strip between the canvas and a side column.
 *
 * Pointer events rather than mouse events, so a pen or touch drag works, and
 * `setPointerCapture` so the drag survives the pointer leaving the 5px strip —
 * without capture, moving faster than React re-renders drops the drag, which is
 * exactly when a resize feels broken.
 *
 * Exposed as a `separator` with arrow-key support because a drag-only control is
 * unusable without a pointer, and this one has no menu equivalent to fall back on.
 */
export function ColumnResizeHandle({
    width,
    onResize,
    bounds = DEFAULT_BOUNDS,
    anchor = 'right',
    label,
}: ColumnResizeHandleProps) {
    const [dragging, setDragging] = useState(false);
    const [hovered, setHovered] = useState(false);

    // Read by the move handler, which is registered once per drag. State would be
    // captured at its stale value there; a ref is the width as of *now*.
    const origin = useRef({ pointerX: 0, width });

    const onPointerDown = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            // Secondary buttons open context menus mid-drag and strand the handle.
            if (event.button !== 0) return;

            event.preventDefault();
            origin.current = { pointerX: event.clientX, width };
            setDragging(true);
            event.currentTarget.setPointerCapture(event.pointerId);
        },
        [width]
    );

    useEffect(() => {
        if (!dragging) return;

        const onPointerMove = (event: PointerEvent) => {
            onResize(
                widthFromDrag(origin.current.width, event.clientX - origin.current.pointerX, bounds, anchor)
            );
        };
        const stop = () => setDragging(false);

        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', stop);
        // A cancelled pointer (an OS gesture taking over, a dialog stealing focus)
        // never fires `pointerup`, so without this the handle stays stuck in a drag.
        window.addEventListener('pointercancel', stop);

        // The whole window, not just the handle: mid-drag the pointer is usually
        // over the canvas, and a text I-beam there reads as "you are selecting",
        // which is not what is happening.
        const previousCursor = document.body.style.cursor;
        const previousSelect = document.body.style.userSelect;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        return () => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', stop);
            window.removeEventListener('pointercancel', stop);
            document.body.style.cursor = previousCursor;
            document.body.style.userSelect = previousSelect;
        };
    }, [dragging, onResize, bounds, anchor]);

    const onKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            // Fed through `widthFromDrag` as a pointer delta rather than applied
            // directly, so the arrow keys inherit the anchor's sign instead of
            // carrying a second copy of it that could disagree with the drag.
            const delta =
                event.key === 'ArrowLeft' ? -KEYBOARD_STEP : event.key === 'ArrowRight' ? KEYBOARD_STEP : 0;
            if (delta === 0) return;

            event.preventDefault();
            onResize(widthFromDrag(width, delta, bounds, anchor));
        },
        [width, onResize, bounds, anchor]
    );

    return (
        <div
            role="separator"
            aria-orientation="vertical"
            aria-label={label}
            aria-valuenow={Math.round(width)}
            aria-valuemin={bounds.min}
            aria-valuemax={bounds.max}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onKeyDown={onKeyDown}
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
            style={{
                width: 5,
                flexShrink: 0,
                cursor: 'col-resize',
                alignSelf: 'stretch',
                background:
                    dragging || hovered ? 'var(--mantine-color-brand-6)' : 'var(--mantine-color-dark-5)',
                transition: dragging ? undefined : 'background 120ms ease',
            }}
        />
    );
}
