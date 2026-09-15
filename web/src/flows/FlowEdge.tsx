import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { createContext, useContext, useState } from 'react';
import { EDGE_STROKE_WIDTH, HANDLE_TONE_HEX } from './nodeMeta';

/**
 * A connection between two blocks, with a way to remove it.
 *
 * React Flow will delete a selected edge on Delete/Backspace out of the box, and
 * that worked here before this component existed — but nothing on screen said so.
 * An author who wanted to rewire two blocks had to delete a whole node and rebuild
 * it, losing its configuration, because the connection looked permanent.
 *
 * So the affordance is a button on the edge itself: hover the connection, click the
 * ✕ at its midpoint. Selecting an edge and pressing Backspace still works and is
 * still handled by React Flow — the page reconciles both onto one undo stack, by
 * two different routes, which is what `graphHistory.ts` exists to reconcile.
 */

interface EdgeActions {
    readonly onDelete: (edgeId: string) => void;
}

/**
 * How the button reaches the page's delete handler.
 *
 * Context rather than `edge.data`, because every edge object is `structuredClone`d
 * into the undo stack on each mutating change, and `structuredClone` throws on a
 * function. Putting the callback on the edge would turn "draw a connection, then
 * undo" into an uncatchable DataCloneError.
 *
 * Context crosses the `EdgeLabelRenderer` portal fine — a portal moves DOM, not the
 * React tree, and this follows the React tree.
 */
const EdgeActionsContext = createContext<EdgeActions | null>(null);

export const EdgeActionsProvider = EdgeActionsContext.Provider;

/** Matches `useGuilds` in `../guilds/GuildContext`: absent provider is a bug, not a mode. */
function useEdgeActions(): EdgeActions {
    const actions = useContext(EdgeActionsContext);
    if (!actions) throw new Error('FlowEdge must be rendered within an EdgeActionsProvider');
    return actions;
}

/** Diameter of the midpoint delete button, in pixels. */
const BUTTON_SIZE = 18;

/** Stroke width of a selected edge. Thicker is the only cue that reads at any zoom. */
const SELECTED_STROKE_WIDTH = 4;

/** Width of the invisible stroke that catches the pointer. Matches React Flow's own default. */
const HIT_STROKE_WIDTH = 20;

export function FlowEdge({
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style,
    markerEnd,
    label,
    labelStyle,
    labelBgStyle,
    selected,
}: EdgeProps) {
    const [hovered, setHovered] = useState(false);
    // Tracked separately from hover so tabbing to the ✕ reveals it. Without this the
    // button is pointer-only, which is the same discoverability gap in a new place.
    const [focused, setFocused] = useState(false);
    const { onDelete } = useEdgeActions();

    const [edgePath, labelX, labelY] = getBezierPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
    });

    // `styleEdge` sets an inline stroke, which overrides React Flow's own
    // `.selected` CSS — so without this a selected edge is indistinguishable from
    // any other, and pressing Delete feels like it fired at random.
    const stroke = style?.stroke ?? HANDLE_TONE_HEX.neutral;
    // The cast is load-bearing: React Flow types this as `StrokeWidth<string | number>`.
    const strokeWidth = selected
        ? SELECTED_STROKE_WIDTH
        : ((style?.strokeWidth as number | undefined) ?? EDGE_STROKE_WIDTH);

    // The delete button is deliberately not shown on selection alone: selection
    // happens on a click meant to *inspect*, and a destructive control appearing
    // under the cursor the user just clicked with is how accidents happen.
    const showDelete = hovered || focused;

    return (
        <>
            <BaseEdge
                id={id}
                path={edgePath}
                markerEnd={markerEnd}
                style={{ ...style, strokeWidth, stroke }}
                /*
                 * Zero, because the hit area is the group below instead.
                 *
                 * `BaseEdge` draws its own invisible 20px stroke by default and
                 * carries no handlers, so leaving it on would render a third
                 * identical path per edge — one that also picks up the infinite
                 * `dashdraw` animation, since the exemption in React Flow's CSS is
                 * keyed on a class only its own path has.
                 */
                interactionWidth={0}
            />

            {/*
             * The hit area: a wide invisible stroke over the visible one, so the
             * pointer does not have to land within 2.5px of a curve. Transparent
             * paths still take pointer events under `pointer-events: visibleStroke`
             * — that property gates on `visibility`, not on paint, which is how
             * React Flow's own `interactionWidth` works.
             *
             * Hover is tracked here and on the button, not on the button alone:
             * `EdgeLabelRenderer` portals the button into a different DOM subtree,
             * so neither element is the other's descendant and each has to report
             * for itself. Together they cover the whole curve-to-button journey.
             */}
            <g onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
                <path d={edgePath} fill="none" strokeOpacity={0} strokeWidth={HIT_STROKE_WIDTH} />
            </g>

            <EdgeLabelRenderer>
                {/*
                 * The handle label ("Yes"/"No") rides at the midpoint when a block
                 * branches. It moves aside for the delete button rather than being
                 * covered by it, so the author can still see which exit they are
                 * about to cut.
                 */}
                {label ? (
                    <div
                        style={{
                            position: 'absolute',
                            transform: `translate(-50%, -50%) translate(${labelX}px, ${
                                showDelete ? labelY - 16 : labelY
                            }px)`,
                            pointerEvents: 'none',
                            padding: '1px 5px',
                            borderRadius: 4,
                            fontSize: 10,
                            fontWeight: 700,
                            transition: 'transform 120ms ease',
                            ...labelBgStyle,
                            ...labelStyle,
                        }}
                    >
                        {label}
                    </div>
                ) : null}

                {/*
                 * Always mounted, faded in and out. Unmounting on hover-out raced
                 * the pointer: the button vanished between the cursor leaving the
                 * curve and arriving at the button, so the ✕ flickered and was
                 * unreliable to click. `pointerEvents` gates the hit area instead,
                 * so an invisible button is not a hidden target.
                 */}
                <button
                    type="button"
                    aria-label="Remove this connection"
                    title="Remove this connection"
                    onMouseEnter={() => setHovered(true)}
                    onMouseLeave={() => setHovered(false)}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    onClick={(event) => {
                        // Without this the click also reaches the pane, which
                        // clears the node selection as a parting gift.
                        event.stopPropagation();
                        onDelete(id);
                    }}
                    style={{
                        position: 'absolute',
                        transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
                        opacity: showDelete ? 1 : 0,
                        // `EdgeLabelRenderer` children are inert by default, so this
                        // is both the enable and the "do not catch stray clicks".
                        pointerEvents: showDelete ? 'all' : 'none',
                        transition: 'opacity 120ms ease',
                        width: BUTTON_SIZE,
                        height: BUTTON_SIZE,
                        padding: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '50%',
                        border: `1px solid ${stroke}`,
                        background: '#1a1b23',
                        color: stroke,
                        fontSize: 11,
                        lineHeight: 1,
                        cursor: 'pointer',
                    }}
                >
                    ✕
                </button>
            </EdgeLabelRenderer>
        </>
    );
}
