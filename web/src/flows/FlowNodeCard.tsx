/**
 * The canvas card for a flow node: kind-coloured header + label + a one-line config
 * summary, matching `flow-builder.mockup.html`. Forking nodes sprout labelled source
 * handles — conditions (`true`/`false`) and the wait node (default / `timeout`);
 * triggers have no target handle.
 */

import { Fragment } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { Text } from '@mantine/core';
import type { GuildChannel, GuildRole } from '../api/types';
import {
    KIND_STYLES,
    branchHandles,
    hasTargetHandle,
    kindOf,
    nodeEmoji,
    summarizeNode,
} from './nodeMeta';

/**
 * What we stash on each React Flow node. `config` is the node's engine `data`;
 * `roles`/`channels` ride along so the card can resolve IDs to names.
 */
export interface FlowNodeCardData extends Record<string, unknown> {
    nodeType: string;
    label: string;
    config: Record<string, unknown>;
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
    const { nodeType, label, config, roles, channels } = data;
    const kind = kindOf(nodeType);
    const style = KIND_STYLES[kind];
    // Conditions fork true/false; the wait node forks event-arrived/timeout.
    const branches = branchHandles(nodeType);

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
            {hasTargetHandle(nodeType) && (
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
                <span>{nodeEmoji(nodeType)}</span>
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
                    {summarizeNode(nodeType, config, roles, channels)}
                </Text>
            </div>

            {branches.length > 0 ? (
                <>
                    {branches.map((branch, index) => {
                        // Stack the labelled outputs down the card's right edge.
                        const labelTop = 52 + index * 26;
                        return (
                            <Fragment key={branch.id ?? 'default'}>
                                <span
                                    style={{
                                        position: 'absolute',
                                        right: 14,
                                        top: labelTop,
                                        fontSize: 10,
                                        fontWeight: 800,
                                        textTransform: 'uppercase',
                                        letterSpacing: '.5px',
                                        color: branch.color,
                                    }}
                                >
                                    {branch.label}
                                </span>
                                <Handle
                                    id={branch.id}
                                    type="source"
                                    position={Position.Right}
                                    style={{
                                        ...HANDLE_BASE,
                                        top: labelTop + 6,
                                        borderColor: branch.color,
                                        background: 'var(--mantine-color-dark-9)',
                                    }}
                                />
                            </Fragment>
                        );
                    })}
                </>
            ) : (
                <Handle type="source" position={Position.Right} style={{ ...HANDLE_BASE, top: 22 }} />
            )}
        </div>
    );
}
