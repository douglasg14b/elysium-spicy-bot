/**
 * The canvas card for a flow node: kind-coloured header + label + a one-line config
 * summary, matching `flow-builder.mockup.html`. Everything it draws — glyph, kind
 * styling, summary, output handles — comes off the block's descriptor, so this file
 * knows no block types.
 */

import { Fragment } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { Text } from '@mantine/core';
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
    const { nodeType, label, config, descriptor, roles, channels } = data;

    if (!descriptor) {
        return <BrokenNodeCard nodeType={nodeType} selected={selected} />;
    }

    const style = KIND_STYLES[descriptor.kind];
    const handles = descriptor.handles;
    const labelled = handlesAreLabelled(handles);

    return (
        <div
            style={{
                width: 210,
                background: 'var(--mantine-color-dark-7)',
                border: `1px solid ${
                    selected ? 'var(--mantine-color-brand-6)' : 'var(--mantine-color-dark-5)'
                }`,
                borderRadius: 12,
                boxShadow: selected
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
                    {style.label}
                </span>
            </div>

            <div style={{ padding: 12 }}>
                <Text size="12px" c="dark.1" lineClamp={2}>
                    {summarizeFromDescriptor(descriptor, config, roles, channels)}
                </Text>
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
