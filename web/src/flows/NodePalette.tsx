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
import type { BlockPaletteGroup, FlowContextRequirement, NodeDescriptor } from '@brattybot/web-sdk';
import { BLOCK_PALETTE_GROUPS } from './contractValues';
import { KIND_STYLES } from './nodeMeta';

/** The dataTransfer key the canvas reads on drop. */
export const NODE_DRAG_MIME = 'application/brattybot-node';

/**
 * Heading per palette group, in the order the palette shows them.
 *
 * Keyed off the generated vocabulary, so a group added to the contract fails to
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
    /**
     * Whether every run this flow can start is about nobody — it has a trigger, and none
     * supplies a member. The page decides it from the canvas; the palette only greys by it.
     */
    runsAboutNobody: boolean;
    onAdd: (nodeType: NodeDescriptor) => void;
}

/** The tooltip on a block greyed because this flow's runs are about nobody. */
export const NEEDS_A_MEMBER_NOTE = "Needs a member — this flow's runs are about nobody.";

/** The requirements that are a person: who the run is about, and who set it off. */
const MEMBER_REQUIREMENTS: readonly FlowContextRequirement[] = ['subject', 'actor'];

/**
 * Whether every way of filling a block in needs a member: its own `requires` says
 * `subject`, or a choice it always shows offers only options that need one — the member
 * choice, "The member this run is about" or "Whoever set this off". A block needing a
 * member for some choices only (Time Since, whose member choice its source can hide)
 * does not: it stays usable, its choices disabled in the inspector instead.
 *
 * The actor counts because a flow whose runs are about nobody has nobody acting either:
 * every shipped trigger that names who acted is also about someone. Advice, like the
 * rest of the greying — the server's check is what refuses.
 */
function alwaysNeedsAMember(entry: NodeDescriptor): boolean {
    return (
        entry.requires.includes('subject') ||
        entry.configFields.some(
            (field) =>
                (field.control === 'select' || field.control === 'segmented') &&
                !field.visibleWhen &&
                field.options.length > 0 &&
                field.options.every((option) =>
                    (option.requires ?? []).some((requirement) => MEMBER_REQUIREMENTS.includes(requirement))
                )
        )
    );
}

/**
 * Whether a palette entry is closed to this flow: a block that always needs a member, on
 * a flow whose runs are all about nobody. Triggers are never greyed, so an author can
 * still add a member trigger and open the rest.
 */
function isGreyed(entry: NodeDescriptor, runsAboutNobody: boolean): boolean {
    return runsAboutNobody && entry.kind !== 'trigger' && alwaysNeedsAMember(entry);
}

export function NodePalette({ nodeTypes, runsAboutNobody, onAdd }: NodePaletteProps) {
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
                                            greyed={isGreyed(entry, runsAboutNobody)}
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
    greyed,
    onAdd,
}: {
    entry: NodeDescriptor;
    /** Closed to this flow: neither draggable nor clickable, and the tooltip says why. */
    greyed: boolean;
    onAdd: (nodeType: NodeDescriptor) => void;
}) {
    const style = KIND_STYLES[entry.kind];

    return (
        <UnstyledButton
            draggable={!greyed}
            // `aria-disabled` rather than `disabled`: a disabled button takes no pointer
            // events, and the hover tooltip is the one thing a greyed entry has to say.
            aria-disabled={greyed || undefined}
            onDragStart={(event) => {
                if (greyed) {
                    event.preventDefault();
                    return;
                }
                event.dataTransfer.setData(NODE_DRAG_MIME, entry.type);
                event.dataTransfer.effectAllowed = 'move';
            }}
            onClick={() => {
                if (!greyed) onAdd(entry);
            }}
            title={greyed ? NEEDS_A_MEMBER_NOTE : `${entry.label} — drag onto the canvas, or click to add`}
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
                cursor: greyed ? 'not-allowed' : 'grab',
                opacity: greyed ? 0.45 : 1,
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
