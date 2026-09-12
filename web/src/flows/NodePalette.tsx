/**
 * Left-hand node palette: the registry from `GET /api/nodes`, grouped by kind with
 * kind-coloured icon chips. Entries are draggable onto the canvas and clickable as a
 * fallback (drag-and-drop is fiddly on trackpads).
 */

import { useMemo, useState } from 'react';
import { ScrollArea, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import type { NodeKind, NodeTypeInfo } from '../api/types';
import { KIND_STYLES, nodeEmoji } from './nodeMeta';

/** The dataTransfer key the canvas reads on drop. */
export const NODE_DRAG_MIME = 'application/spicybot-node';

const GROUPS: Array<{ kind: NodeKind; heading: string }> = [
    { kind: 'trigger', heading: 'Triggers' },
    { kind: 'condition', heading: 'Conditions' },
    { kind: 'action', heading: 'Actions' },
];

interface NodePaletteProps {
    nodeTypes: NodeTypeInfo[];
    onAdd: (nodeType: NodeTypeInfo) => void;
}

export function NodePalette({ nodeTypes, onAdd }: NodePaletteProps) {
    const [query, setQuery] = useState('');

    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return nodeTypes;
        return nodeTypes.filter(
            (n) =>
                n.label.toLowerCase().includes(needle) || n.type.toLowerCase().includes(needle)
        );
    }, [nodeTypes, query]);

    return (
        <Stack gap="sm" h="100%" p="md" style={{ overflow: 'hidden' }}>
            <TextInput
                placeholder="Search nodes…"
                leftSection={<IconSearch size={15} />}
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                size="sm"
            />

            <ScrollArea style={{ flex: 1 }} type="auto">
                <Stack gap="lg" pb="md">
                    {GROUPS.map(({ kind, heading }) => {
                        const entries = filtered.filter((n) => n.kind === kind);
                        if (entries.length === 0) return null;
                        const style = KIND_STYLES[kind];

                        return (
                            <div key={kind}>
                                <Text
                                    size="10.5px"
                                    fw={800}
                                    tt="uppercase"
                                    c={`${style.color}.4`}
                                    mb={8}
                                    px={4}
                                    style={{ letterSpacing: '.6px' }}
                                >
                                    {heading}
                                </Text>
                                <Stack gap={6}>
                                    {entries.map((entry) => (
                                        <PaletteItem
                                            key={entry.type}
                                            entry={entry}
                                            onAdd={onAdd}
                                        />
                                    ))}
                                </Stack>
                            </div>
                        );
                    })}

                    {filtered.length === 0 && (
                        <Text size="xs" c="dimmed" px={4}>
                            Nothing matches “{query}”.
                        </Text>
                    )}
                </Stack>
            </ScrollArea>
        </Stack>
    );
}

function PaletteItem({
    entry,
    onAdd,
}: {
    entry: NodeTypeInfo;
    onAdd: (nodeType: NodeTypeInfo) => void;
}) {
    const style = KIND_STYLES[entry.kind];

    return (
        <UnstyledButton
            draggable
            onDragStart={(event) => {
                event.dataTransfer.setData(NODE_DRAG_MIME, entry.type);
                event.dataTransfer.effectAllowed = 'move';
            }}
            onClick={() => onAdd(entry)}
            title={`${entry.label} — drag onto the canvas, or click to add`}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                background: 'var(--mantine-color-dark-7)',
                border: '1px solid var(--mantine-color-dark-5)',
                borderRadius: 9,
                padding: '9px 11px',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'grab',
            }}
        >
            <span
                style={{
                    width: 26,
                    height: 26,
                    borderRadius: 7,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 13,
                    flexShrink: 0,
                    background: style.softBg,
                }}
            >
                {nodeEmoji(entry.type)}
            </span>
            <Text size="13px" fw={600} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {entry.label}
            </Text>
        </UnstyledButton>
    );
}
