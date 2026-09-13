/**
 * Left-hand node palette: the registry from `GET /api/nodes`, grouped by each
 * block's declared `group` with kind-coloured icon chips. Entries are draggable onto
 * the canvas and clickable as a fallback (drag-and-drop is fiddly on trackpads).
 *
 * Grouping plus search, rather than one flat list: the block set is built to grow,
 * and a flat list stops being navigable well before it finishes growing.
 */

import { useMemo, useState } from 'react';
import { ScrollArea, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { BLOCK_PALETTE_GROUPS, type BlockPaletteGroup, type NodeDescriptor } from '../api/types';
import { KIND_STYLES } from './nodeMeta';

/** The dataTransfer key the canvas reads on drop. */
export const NODE_DRAG_MIME = 'application/spicybot-node';

/**
 * Heading per palette group, in the order the palette shows them.
 *
 * Keyed off the mirrored vocabulary, so a group added to the contract fails to
 * compile here until it is given a heading — the palette cannot silently drop a
 * section's worth of blocks.
 */
const GROUP_HEADINGS: Record<BlockPaletteGroup, string> = {
    triggers: 'Triggers',
    conditions: 'Conditions',
    actions: 'Actions',
};

interface NodePaletteProps {
    nodeTypes: NodeDescriptor[];
    onAdd: (nodeType: NodeDescriptor) => void;
}

export function NodePalette({ nodeTypes, onAdd }: NodePaletteProps) {
    const [query, setQuery] = useState('');

    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return nodeTypes;
        return nodeTypes.filter(
            (entry) =>
                entry.label.toLowerCase().includes(needle) ||
                entry.type.toLowerCase().includes(needle)
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
                    {BLOCK_PALETTE_GROUPS.map((group) => {
                        const entries = filtered.filter((entry) => entry.group === group);
                        if (entries.length === 0) return null;
                        // Kind drives colour; group drives the section. They line up
                        // for today's blocks but are separate facts, so read the
                        // colour off the group's first block in the *unfiltered*
                        // catalogue — searching must not recolour a heading.
                        // The unfiltered lookup always finds at least the blocks in
                        // `entries`; the fallback just avoids a non-null assertion.
                        const groupKind =
                            nodeTypes.find((entry) => entry.group === group)?.kind ??
                            entries[0].kind;
                        const style = KIND_STYLES[groupKind];

                        return (
                            <div key={group}>
                                <Text
                                    size="10.5px"
                                    fw={800}
                                    tt="uppercase"
                                    c={`${style.color}.4`}
                                    mb={8}
                                    px={4}
                                    style={{ letterSpacing: '.6px' }}
                                >
                                    {GROUP_HEADINGS[group]}
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
    entry: NodeDescriptor;
    onAdd: (nodeType: NodeDescriptor) => void;
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
                {entry.icon}
            </span>
            <Text size="13px" fw={600} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {entry.label}
            </Text>
        </UnstyledButton>
    );
}
