/**
 * Right-hand inspector. Renders the selected block's declared `configFields`, in
 * order, through the shared control library — editing `data` live (no Apply button;
 * changes land in local graph state and are persisted by the toolbar's Save).
 *
 * This file knows no block types. Everything it draws comes off the descriptor.
 */

import { Button, Divider, Group, Stack, Text } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import type { GuildChannel, GuildRole, NodeDescriptor } from '../api/types';
import { renderControl } from './controls/renderControl';
import type { ControlContext } from './controls/types';
import { KIND_STYLES } from './nodeMeta';

interface NodeInspectorProps {
    /** The block this node instantiates, absent when its type is unknown to this build. */
    descriptor: NodeDescriptor | undefined;
    nodeType: string;
    label: string;
    config: Record<string, unknown>;
    roles: GuildRole[];
    channels: GuildChannel[];
    onChange: (patch: Record<string, unknown>) => void;
    onDelete: () => void;
}

export function NodeInspector({
    descriptor,
    nodeType,
    label,
    config,
    roles,
    channels,
    onChange,
    onDelete,
}: NodeInspectorProps) {
    if (!descriptor) {
        return <UnknownNodeInspector nodeType={nodeType} onDelete={onDelete} />;
    }

    const style = KIND_STYLES[descriptor.kind];
    const context: ControlContext = { roles, channels };

    return (
        <Stack gap="md" p="md" h="100%" style={{ overflowY: 'auto' }}>
            <Group gap={10} wrap="nowrap">
                <span
                    style={{
                        width: 30,
                        height: 30,
                        borderRadius: 8,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 15,
                        flexShrink: 0,
                        background: style.softBg,
                    }}
                >
                    {descriptor.icon}
                </span>
                <div style={{ overflow: 'hidden' }}>
                    <Text fw={800} size="15px" truncate>
                        {label}
                    </Text>
                    <Text size="11px" c="dark.2" tt="uppercase" fw={700} style={{ letterSpacing: '.5px' }}>
                        {style.label} node
                    </Text>
                </div>
            </Group>

            <Text size="12.5px" c="dimmed">
                {descriptor.description}
            </Text>

            <Divider />

            <Stack gap="md">
                {descriptor.configFields.map((field) => (
                    <div key={field.key}>
                        {renderControl(
                            field,
                            config[field.key],
                            (value) => onChange({ [field.key]: value }),
                            context
                        )}
                    </div>
                ))}

                {descriptor.note ? (
                    <Text size="11.5px" c="dimmed">
                        {descriptor.note}
                    </Text>
                ) : null}
            </Stack>

            <Divider mt="auto" />

            <Button
                variant="light"
                color="red"
                leftSection={<IconTrash size={16} />}
                onClick={onDelete}
            >
                Delete node
            </Button>
        </Stack>
    );
}

/**
 * Inspector for a node whose block this build does not have.
 *
 * There is nothing to configure — we do not know what its fields were — so the only
 * honest offer is to remove it.
 */
function UnknownNodeInspector({
    nodeType,
    onDelete,
}: {
    nodeType: string;
    onDelete: () => void;
}) {
    return (
        <Stack gap="md" p="md" h="100%" style={{ overflowY: 'auto' }}>
            <Group gap={10} wrap="nowrap">
                <span
                    style={{
                        width: 30,
                        height: 30,
                        borderRadius: 8,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 15,
                        flexShrink: 0,
                        background: 'rgba(237,66,69,.18)',
                    }}
                >
                    ⚠️
                </span>
                <div style={{ overflow: 'hidden' }}>
                    <Text fw={800} size="15px" truncate>
                        Unknown block
                    </Text>
                    <Text size="11px" c="red.4" tt="uppercase" fw={700} style={{ letterSpacing: '.5px' }}>
                        Broken node
                    </Text>
                </div>
            </Group>

            <Text size="12.5px" c="dimmed">
                This flow references a block this build doesn&apos;t have, so there&apos;s nothing
                to configure. Saving won&apos;t work until it&apos;s gone.
            </Text>

            <Text size="12px" c="red.4" style={{ wordBreak: 'break-all' }}>
                {nodeType}
            </Text>

            <Divider mt="auto" />

            <Button
                variant="light"
                color="red"
                leftSection={<IconTrash size={16} />}
                onClick={onDelete}
            >
                Delete node
            </Button>
        </Stack>
    );
}
