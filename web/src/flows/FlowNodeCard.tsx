/**
 * The canvas card for a flow node: kind-coloured header + label + a one-line config
 * summary, matching `flow-builder.mockup.html`. Everything it draws — glyph, kind
 * styling, summary, output handles — comes off the block's descriptor, so this file
 * knows no block types.
 */

import { Fragment } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { GuildChannel, GuildRole, NodeDescriptor } from '../api/types';
import { summarizeFromDescriptor } from './cardSummary';
import { handlesAreLabelled, HANDLE_TONE_COLORS, KIND_STYLES } from './nodeMeta';

/**
 * What we stash on each React Flow node. `config` is the node's engine `data`;
 * `descriptor` is the block it instantiates, absent when the saved graph names a
 * type this build has no block for. `roles`/`channels` ride along so the card can
 * resolve IDs to names.
 */
export interface FlowNodeCardData extends Record<string, unknown> {
    nodeType: string;
    label: string;
    config: Record<string, unknown>;
    descriptor: NodeDescriptor | undefined;
    roles: GuildRole[];
    channels: GuildChannel[];
    /**
     * How many things the last save found wrong with this node.
     *
     * A count rather than the issues themselves: the card has room for a number and
     * the inspector is where they are read. Carrying the list here would put the
     * same objects on every card in every undo snapshot for nothing.
     */
    issueCount: number;
    /**
     * Whether no trigger can reach this node, so it never runs.
     *
     * Legal, and not a save failure — which is why it is a separate field rather than
     * another thing folded into `issueCount`. The two are different claims with
     * different lifetimes: `issueCount` is what the *last save* found and is cleared on
     * the next attempt, while this is recomputed from the live graph on every edit.
     *
     * A boolean rather than a reason: there is only one way to be unreachable, and the
     * card has room to say it once.
     */
    unreachable: boolean;
}

export type FlowCardNode = Node<FlowNodeCardData, 'flowCard'>;

const HANDLE_BASE: React.CSSProperties = {
    width: 12,
    height: 12,
    borderWidth: 2,
    borderStyle: 'solid',
    background: 'var(--mantine-color-dark-6)',
    borderColor: 'var(--mantine-color-dark-3)',
};

export function FlowNodeCard({ data, selected }: NodeProps<FlowCardNode>) {
    const { nodeType, label, config, descriptor, roles, channels, issueCount, unreachable } = data;

    if (!descriptor) {
        return <BrokenNodeCard nodeType={nodeType} selected={selected} />;
    }

    const style = KIND_STYLES[descriptor.kind];
    const handles = descriptor.handles;
    const labelled = handlesAreLabelled(handles);
    const failed = issueCount > 0;
    /*
     * Shown only when the card is not already failing.
     *
     * A red card is about to be refused; telling the author it also would not have run
     * is a second problem they cannot act on until the first is fixed. Red wins, and
     * the advisory reappears once it is green again — the same precedence `borderColor`
     * takes between failure and selection.
     */
    const adrift = unreachable && !failed;

    return (
        <div
            /*
             * Announced when it failed, for the same reason the broken card is:
             * this is the state that stops a save, and noticing it must not depend
             * on seeing red. Left off an ordinary card so the canvas is not a wall
             * of alerts.
             */
            role={failed ? 'alert' : undefined}
            style={{
                width: 210,
                background: 'var(--mantine-color-dark-7)',
                // Failure outranks selection: an author clicking an errored node to
                // read its issues must not have the card stop looking errored.
                border: `1px solid ${borderColor(failed, selected)}`,
                /*
                 * The amber edge, on the one side no other state uses.
                 *
                 * Border colour, the ring and the header corner are all spoken for by
                 * failure and selection, and overloading any of them would make an
                 * advisory compete with a refusal. Dashed rather than solid because the
                 * claim is "nothing flows through here", which is what a broken line
                 * says without a legend.
                 */
                ...(adrift
                    ? {
                          borderLeft: '3px dashed var(--mantine-color-yellow-6)',
                          borderTopLeftRadius: 12,
                          borderBottomLeftRadius: 12,
                      }
                    : {}),
                borderRadius: 12,
                /*
                 * Dimmed, so it reads as "this does not run" without depending on
                 * colour at all. Selection still lifts it back to full strength: an
                 * author who clicked it is working on it, and fading the thing under
                 * the cursor is the one moment this would be in the way.
                 */
                opacity: adrift && !selected ? 0.55 : 1,
                boxShadow: failed
                    ? '0 0 0 2px rgba(237,66,69,.5), 0 8px 24px rgba(0,0,0,.4)'
                    : selected
                      ? '0 0 0 2px rgba(0,162,255,.5), 0 8px 24px rgba(0,0,0,.4)'
                      : '0 8px 24px rgba(0,0,0,.35)',
            }}
        >
            {descriptor.kind !== 'trigger' && (
                <Handle type="target" position={Position.Left} style={{ ...HANDLE_BASE, top: 22 }} />
            )}

            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '10px 12px',
                    borderRadius: '11px 11px 0 0',
                    fontWeight: 700,
                    fontSize: 13,
                    color: style.headerText,
                    background: style.headerGradient,
                }}
            >
                <span>{descriptor.icon}</span>
                <span
                    style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {label}
                </span>
                <span
                    style={{
                        fontSize: 9.5,
                        textTransform: 'uppercase',
                        letterSpacing: '.5px',
                        opacity: 0.85,
                        fontWeight: 800,
                        marginLeft: 'auto',
                    }}
                >
                    {failed ? <IssueBadge count={issueCount} /> : style.label}
                </span>
            </div>

            <div style={{ padding: 12 }}>
                <Text size="12px" c="dark.1" lineClamp={2}>
                    {summarizeFromDescriptor(descriptor, config, roles, channels)}
                </Text>
                {failed ? (
                    // Counted in problems rather than fields: two rules can fail on
                    // one control, and promising "3 fields" over two would be a lie
                    // the author notices the moment they open it.
                    <Text size="11px" c="red.4" mt={4}>
                        Open it — {issueCount === 1 ? 'one problem' : `${issueCount} problems`} to fix.
                    </Text>
                ) : null}
                {adrift ? (
                    /*
                     * Named, because dimming alone says "different" and not "why".
                     *
                     * Phrased as the consequence rather than the graph property: "no
                     * trigger reaches this" describes the topology an author is looking
                     * at anyway, while "never runs" is the thing they care about and
                     * did not know.
                     */
                    <Text size="11px" c="yellow.5" mt={4}>
                        Nothing reaches this — it never runs.
                    </Text>
                ) : null}
            </div>

            {labelled ? (
                handles.map((handle, index) => {
                    // Stack the labelled outputs down the card's right edge.
                    const labelTop = 52 + index * 26;
                    const color = HANDLE_TONE_COLORS[handle.tone];
                    return (
                        <Fragment key={handle.id ?? 'default'}>
                            <span
                                style={{
                                    position: 'absolute',
                                    right: 14,
                                    top: labelTop,
                                    fontSize: 10,
                                    fontWeight: 800,
                                    textTransform: 'uppercase',
                                    letterSpacing: '.5px',
                                    color,
                                }}
                            >
                                {handle.label}
                            </span>
                            <Handle
                                id={handle.id}
                                type="source"
                                position={Position.Right}
                                style={{
                                    ...HANDLE_BASE,
                                    top: labelTop + 6,
                                    borderColor: color,
                                    background: 'var(--mantine-color-dark-9)',
                                }}
                            />
                        </Fragment>
                    );
                })
            ) : (
                <Handle
                    id={handles[0]?.id}
                    type="source"
                    position={Position.Right}
                    style={{ ...HANDLE_BASE, top: 22 }}
                />
            )}
        </div>
    );
}

/** Card border, with failure outranking selection. */
function borderColor(failed: boolean, selected: boolean): string {
    if (failed) return 'var(--mantine-color-red-5)';
    return selected ? 'var(--mantine-color-brand-6)' : 'var(--mantine-color-dark-5)';
}

/**
 * The issue count, in the corner the block kind's label usually occupies.
 *
 * It replaces that label rather than sitting beside it: the strip is 210px wide and
 * already holds an icon and a name, and "ACTION" is the one thing there an author
 * looking at a failed save does not need. The kind is still legible from the header
 * colour and the icon.
 */
function IssueBadge({ count }: { count: number }) {
    return (
        <span
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                padding: '1px 6px',
                borderRadius: 999,
                background: 'rgba(237,66,69,.9)',
                color: '#ffffff',
            }}
        >
            <IconAlertTriangle size={10} />
            {count}
        </span>
    );
}

/**
 * A saved node whose block this build does not have.
 *
 * Deliberately unmistakable rather than a generic card: the save path already
 * rejects an unknown type, and this is the visible half of that. It names the type
 * so the reader knows what went missing, and offers no handles, because we have no
 * idea what this block's exits were.
 */
function BrokenNodeCard({ nodeType, selected }: { nodeType: string; selected: boolean }) {
    return (
        <div
            // Announced, not just coloured: this is the one node state that blocks
            // saving outright, so noticing it cannot depend on seeing red.
            role="alert"
            style={{
                width: 210,
                background: 'var(--mantine-color-dark-7)',
                border: `1px dashed ${
                    selected ? 'var(--mantine-color-red-4)' : 'var(--mantine-color-red-6)'
                }`,
                borderRadius: 12,
                boxShadow: selected
                    ? '0 0 0 2px rgba(237,66,69,.5), 0 8px 24px rgba(0,0,0,.4)'
                    : '0 8px 24px rgba(0,0,0,.35)',
            }}
        >
            <Handle type="target" position={Position.Left} style={{ ...HANDLE_BASE, top: 22 }} />

            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '10px 12px',
                    borderRadius: '11px 11px 0 0',
                    fontWeight: 700,
                    fontSize: 13,
                    color: '#ffffff',
                    background: 'linear-gradient(135deg, #a12d2f, #ed4245)',
                }}
            >
                <span>⚠️</span>
                <span
                    style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}
                >
                    Unknown block
                </span>
                <span
                    style={{
                        fontSize: 9.5,
                        textTransform: 'uppercase',
                        letterSpacing: '.5px',
                        opacity: 0.85,
                        fontWeight: 800,
                        marginLeft: 'auto',
                    }}
                >
                    Broken
                </span>
            </div>

            <div style={{ padding: 12 }}>
                <Text size="12px" c="red.4" style={{ wordBreak: 'break-all' }}>
                    {nodeType}
                </Text>
                <Text size="11px" c="dimmed" mt={4}>
                    This build has no such block. Delete it, or the flow won&apos;t save.
                </Text>
            </div>
        </div>
    );
}
