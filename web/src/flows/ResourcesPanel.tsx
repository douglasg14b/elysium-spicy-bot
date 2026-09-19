/**
 * Declare the guild objects a flow needs but does not yet have.
 *
 * This is the authoring surface for what provisioning installs. A resource declared
 * here is offered by the pickers immediately — the point of the whole feature is that
 * building a flow no longer requires creating its channels by hand first.
 *
 * The panel never says "journey". A flow's journey is implicit, keyed on the flow's
 * own id, so the operator declares what this flow needs and the scope follows from
 * that. Grouping several flows under one journey is deferred (PRD §5.8 item 39).
 */

import { useState } from 'react';
import {
    ActionIcon,
    Alert,
    Badge,
    Button,
    Group,
    Menu,
    Select,
    Stack,
    Text,
    TextInput,
    Tooltip,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import type { ResourceDeclaration, ResourceKind } from '../api/types';

interface ResourcesPanelProps {
    resources: ResourceDeclaration[];
    onChange: (next: ResourceDeclaration[]) => void;
    /** Set while a save is in flight, so the panel cannot be edited mid-write. */
    saving?: boolean;
    /** A rejected save, shown verbatim — the server's message names the real problem. */
    error?: string;
}

const KIND_LABEL: Record<ResourceKind, string> = {
    category: 'Category',
    textChannel: 'Channel',
    role: 'Role',
};

const KIND_PREFIX: Record<ResourceKind, string> = {
    category: '',
    textChannel: '#',
    role: '@',
};

/**
 * Derive a key from a display name.
 *
 * Keys must be slug-shaped (the server rejects anything else), and asking an operator
 * to invent one alongside a name is asking them to understand why the distinction
 * exists. They can still edit it — a key is permanent in a way a name is not, so it
 * stays visible rather than hidden.
 */
function slugify(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
}

export function ResourcesPanel({ resources, onChange, saving, error }: ResourcesPanelProps) {
    const [pendingName, setPendingName] = useState('');

    const categories = resources.filter((resource) => resource.kind === 'category');

    function addResource(kind: ResourceKind) {
        const name = pendingName.trim() || `new-${kind === 'textChannel' ? 'channel' : kind}`;
        let key = slugify(name);

        // A duplicate key is rejected by the server, and silently renaming the
        // operator's resource would be worse than a suffix they can see and edit.
        if (resources.some((resource) => resource.key === key)) {
            let suffix = 2;
            while (resources.some((resource) => resource.key === `${key}-${suffix}`)) suffix += 1;
            key = `${key}-${suffix}`;
        }

        onChange([...resources, { key, kind, defaultName: name }]);
        setPendingName('');
    }

    /**
     * Patch by position, not by key.
     *
     * The key is itself editable, so matching on it would break the moment an operator
     * typed into the key field: the first keystroke changes the value being matched
     * against, and every later keystroke would find no row.
     */
    function updateResource(index: number, patch: Partial<ResourceDeclaration>) {
        onChange(
            resources.map((resource, position) =>
                position === index ? { ...resource, ...patch } : resource
            )
        );
    }

    function removeResource(index: number) {
        const removed = resources[index];
        // Anything parented to the removed category would name a parent that no longer
        // exists, which the server rejects as an invalid declaration. Clearing the
        // parent here keeps the list saveable, and the change is visible in the UI.
        onChange(
            resources
                .filter((_resource, position) => position !== index)
                .map((resource) =>
                    resource.parentKey === removed?.key
                        ? { ...resource, parentKey: undefined }
                        : resource
                )
        );
    }

    return (
        <Stack gap="md" p="md" h="100%" style={{ overflowY: 'auto' }}>
            <div>
                <Text fw={800} size="15px">
                    Resources
                </Text>
                <Text size="12px" c="dimmed">
                    Channels and roles this flow needs. Declare them here and they show up in the
                    pickers straight away — you can build the whole flow before any of them exist.
                </Text>
            </div>

            {error && (
                <Alert color="red" variant="light" p="xs">
                    <Text size="12px">{error}</Text>
                </Alert>
            )}

            <Group gap={6} wrap="nowrap">
                <TextInput
                    placeholder="Name it, e.g. questions"
                    value={pendingName}
                    onChange={(event) => setPendingName(event.currentTarget.value)}
                    size="xs"
                    style={{ flex: 1 }}
                    disabled={saving}
                />
                <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                        <Button
                            size="xs"
                            variant="light"
                            leftSection={<IconPlus size={14} />}
                            disabled={saving}
                        >
                            Add
                        </Button>
                    </Menu.Target>
                    <Menu.Dropdown>
                        <Menu.Item onClick={() => addResource('textChannel')}>Channel</Menu.Item>
                        <Menu.Item onClick={() => addResource('category')}>Category</Menu.Item>
                        <Menu.Item onClick={() => addResource('role')}>Role</Menu.Item>
                    </Menu.Dropdown>
                </Menu>
            </Group>

            {resources.length === 0 ? (
                <Text size="12px" c="dimmed" ta="center" pt="md">
                    Nothing declared yet. If this flow only uses channels that already exist, it
                    doesn&apos;t need anything here.
                </Text>
            ) : (
                <Stack gap="xs">
                    {resources.map((resource, index) => (
                        <ResourceRow
                            // Position, not the key: the key is editable, and a React
                            // key that changes on every keystroke remounts the input
                            // and loses focus mid-word.
                            key={index}
                            resource={resource}
                            categories={categories.filter(
                                (category) => category.key !== resource.key
                            )}
                            disabled={Boolean(saving)}
                            onUpdate={(patch) => updateResource(index, patch)}
                            onRemove={() => removeResource(index)}
                        />
                    ))}
                </Stack>
            )}
        </Stack>
    );
}

interface ResourceRowProps {
    resource: ResourceDeclaration;
    categories: ResourceDeclaration[];
    disabled: boolean;
    onUpdate: (patch: Partial<ResourceDeclaration>) => void;
    onRemove: () => void;
}

function ResourceRow({ resource, categories, disabled, onUpdate, onRemove }: ResourceRowProps) {
    // Roles do not live under categories, and the server rejects a role that names a
    // parent. Offering the control at all would invite a save that cannot succeed.
    const canHaveParent = resource.kind !== 'role' && categories.length > 0;

    return (
        <Stack
            gap={6}
            p="xs"
            style={{
                background: 'var(--mantine-color-dark-7)',
                border: '1px solid var(--mantine-color-dark-5)',
                borderRadius: 6,
            }}
        >
            <Group gap={6} wrap="nowrap" justify="space-between">
                <Badge size="xs" variant="light">
                    {KIND_LABEL[resource.kind]}
                </Badge>
                <Tooltip label="Remove" withArrow>
                    <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="red"
                        onClick={onRemove}
                        disabled={disabled}
                    >
                        <IconTrash size={14} />
                    </ActionIcon>
                </Tooltip>
            </Group>

            <TextInput
                size="xs"
                label="Name"
                description="What it gets called when created. You can rename it in Discord later."
                value={resource.defaultName}
                onChange={(event) => onUpdate({ defaultName: event.currentTarget.value })}
                leftSection={
                    KIND_PREFIX[resource.kind] ? (
                        <Text size="12px" c="dimmed">
                            {KIND_PREFIX[resource.kind]}
                        </Text>
                    ) : undefined
                }
                disabled={disabled}
            />

            <TextInput
                size="xs"
                label="Key"
                description="How this flow refers to it. Renaming in Discord won't break it."
                value={resource.key}
                onChange={(event) => onUpdate({ key: event.currentTarget.value })}
                disabled={disabled}
            />

            {canHaveParent && (
                <Select
                    size="xs"
                    label="Inside category"
                    placeholder="Top level"
                    data={categories.map((category) => ({
                        value: category.key,
                        label: category.defaultName,
                    }))}
                    value={resource.parentKey ?? null}
                    onChange={(next) => onUpdate({ parentKey: next ?? undefined })}
                    clearable
                    disabled={disabled}
                />
            )}
        </Stack>
    );
}
