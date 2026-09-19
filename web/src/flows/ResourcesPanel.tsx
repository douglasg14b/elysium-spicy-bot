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
 *
 * It lives in a modal off the toolbar rather than in the right-hand column. That
 * column is for the *selected node's* configuration; a flow-wide concern sharing it
 * meant selecting a block showed nothing while resources were open. Permission
 * editing also wants more width than 300px.
 */

import { useState } from 'react';
import {
    ActionIcon,
    Alert,
    Badge,
    Button,
    Divider,
    Group,
    Select,
    Stack,
    Text,
    TextInput,
    Tooltip,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import type { GuildRole, PermissionIntent, ResourceDeclaration, ResourceKind } from '../api/types';
import { declaredRoleOptionValue } from './declaredRoleReference';
import { PermissionIntentEditor } from './PermissionIntentEditor';
import { RESOURCE_KIND_ORDER, RESOURCE_KIND_STYLES } from './resourceMeta';

interface ResourcesPanelProps {
    resources: ResourceDeclaration[];
    onChange: (next: ResourceDeclaration[]) => void;
    /** Real roles in the guild, for permission rules that name one. */
    roles: GuildRole[];
    /** Set while a save is in flight, so the panel cannot be edited mid-write. */
    saving?: boolean;
    /** A rejected save, shown verbatim — the server's message names the real problem. */
    error?: string;
}

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

export function ResourcesPanel({
    resources,
    onChange,
    roles,
    saving,
    error,
}: ResourcesPanelProps) {
    const [pendingName, setPendingName] = useState('');
    // Kind is chosen before adding, not from a dropdown menu that hides the choice
    // behind a click. A wrong kind is otherwise silent until install.
    const [pendingKind, setPendingKind] = useState<ResourceKind>('textChannel');
    const [pendingParentKey, setPendingParentKey] = useState<string | null>(null);

    const categories = resources.filter((resource) => resource.kind === 'category');
    const declaredRoles = resources.filter((resource) => resource.kind === 'role');

    // Roles never live under a category, and the server rejects one that names a
    // parent — so the control disappears rather than offering a save that cannot work.
    const pendingCanHaveParent = pendingKind !== 'role' && categories.length > 0;

    function addResource() {
        const name =
            pendingName.trim() || `new-${pendingKind === 'textChannel' ? 'channel' : pendingKind}`;
        let key = slugify(name);

        // A duplicate key is rejected by the server, and silently renaming the
        // operator's resource would be worse than a suffix they can see and edit.
        if (resources.some((resource) => resource.key === key)) {
            let suffix = 2;
            while (resources.some((resource) => resource.key === `${key}-${suffix}`)) suffix += 1;
            key = `${key}-${suffix}`;
        }

        const declaration: ResourceDeclaration = { key, kind: pendingKind, defaultName: name };
        // Folded into creation rather than left as a second edit on a row that already
        // exists. Only carried when the kind can actually hold one.
        if (pendingCanHaveParent && pendingParentKey) {
            declaration.parentKey = pendingParentKey;
        }

        onChange([...resources, declaration]);
        setPendingName('');
        setPendingParentKey(null);
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
            resources.map((resource, position) => {
                if (position !== index) return resource;
                const next = { ...resource, ...patch };
                // An explicit `undefined` in a patch means *remove the key*. Spreading
                // alone leaves it present holding `undefined`, which `JSON.stringify`
                // drops on the way out — so the in-memory list and the saved one would
                // disagree about whether a resource inherits its permissions.
                for (const [patchKey, value] of Object.entries(patch)) {
                    if (value === undefined) {
                        delete next[patchKey as keyof ResourceDeclaration];
                    }
                }
                return next;
            })
        );
    }

    function removeResource(index: number) {
        const removed = resources[index];
        if (!removed) return;

        onChange(
            resources
                .filter((_resource, position) => position !== index)
                .map((resource) => {
                    let next = resource;

                    // Anything parented to the removed category would name a parent
                    // that no longer exists, which the server rejects as an invalid
                    // declaration. Clearing it here keeps the list saveable, visibly.
                    if (next.parentKey === removed.key) {
                        const { parentKey: _dropped, ...withoutParent } = next;
                        next = withoutParent;
                    }

                    // Same problem one level down, and it is the one item 4 made
                    // reachable: a permission naming the removed *role* by key is now
                    // a reference the journey does not declare, which
                    // `validateJourneyDeclaration` refuses. Dropping the reference
                    // keeps the save working; the rule stays, minus the dead role.
                    if (removed.kind === 'role' && next.permissions) {
                        next = { ...next, permissions: withoutRoleKey(next.permissions, removed.key) };
                    }

                    return next;
                })
        );
    }

    return (
        <Stack gap="md">
            <Text size="12.5px" c="dimmed">
                Channels and roles this flow needs. Declare them here and they show up in the
                pickers straight away — you can build the whole flow before any of them exist.
            </Text>

            {error && (
                <Alert color="red" variant="light" p="xs">
                    <Text size="12px">{error}</Text>
                </Alert>
            )}

            <Stack
                gap={8}
                p="sm"
                style={{
                    background: 'var(--mantine-color-dark-7)',
                    border: '1px solid var(--mantine-color-dark-5)',
                    borderRadius: 6,
                }}
            >
                <Text size="12px" fw={700}>
                    Declare something new
                </Text>

                <Group gap={6} wrap="nowrap" align="flex-end">
                    <Button.Group>
                        {RESOURCE_KIND_ORDER.map((kind) => {
                            const style = RESOURCE_KIND_STYLES[kind];
                            const KindIcon = style.icon;
                            const active = pendingKind === kind;
                            return (
                                <Button
                                    key={kind}
                                    size="xs"
                                    variant={active ? 'filled' : 'default'}
                                    color={active ? style.color : undefined}
                                    leftSection={<KindIcon size={14} />}
                                    onClick={() => {
                                        setPendingKind(kind);
                                        // A role cannot hold a parent, so a pending one
                                        // would be silently dropped at add time.
                                        if (kind === 'role') setPendingParentKey(null);
                                    }}
                                    disabled={saving}
                                >
                                    {style.label}
                                </Button>
                            );
                        })}
                    </Button.Group>
                </Group>

                <Group gap={6} wrap="nowrap" align="flex-end">
                    <TextInput
                        label="Name"
                        placeholder={RESOURCE_KIND_STYLES[pendingKind].namePlaceholder}
                        value={pendingName}
                        onChange={(event) => setPendingName(event.currentTarget.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') addResource();
                        }}
                        size="xs"
                        style={{ flex: 1 }}
                        disabled={saving}
                        leftSection={
                            RESOURCE_KIND_STYLES[pendingKind].prefix ? (
                                <Text size="12px" c="dimmed">
                                    {RESOURCE_KIND_STYLES[pendingKind].prefix}
                                </Text>
                            ) : undefined
                        }
                    />

                    {pendingCanHaveParent && (
                        <Select
                            size="xs"
                            label="Inside category"
                            placeholder="Top level"
                            data={categories.map((category) => ({
                                value: category.key,
                                label: category.defaultName,
                            }))}
                            value={pendingParentKey}
                            onChange={setPendingParentKey}
                            clearable
                            disabled={saving}
                            w={160}
                            comboboxProps={{ withinPortal: true }}
                        />
                    )}

                    <Button
                        size="xs"
                        variant="light"
                        leftSection={<IconPlus size={14} />}
                        onClick={addResource}
                        disabled={saving}
                    >
                        Add
                    </Button>
                </Group>
            </Stack>

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
                            roles={roles}
                            declaredRoles={declaredRoles.filter(
                                // A role granting itself permissions is meaningless,
                                // and a role has no overwrites at all.
                                (declared) => declared.key !== resource.key
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

/**
 * Drop every reference to one declared role from a set of intents.
 *
 * A rule left naming nothing is removed rather than kept as an empty `roles` intent:
 * the server rejects `roles` with no ids, so keeping it would make the whole list
 * unsaveable to clear a role the operator just deleted.
 */
function withoutRoleKey(
    permissions: PermissionIntent[],
    removedKey: string
): PermissionIntent[] {
    const reference = declaredRoleOptionValue(removedKey);

    return permissions.flatMap((intent) => {
        if (intent.audience !== 'roles' || !intent.roleIds) return [intent];

        const roleIds = intent.roleIds.filter((roleId) => roleId !== reference);
        if (roleIds.length === intent.roleIds.length) return [intent];
        return roleIds.length > 0 ? [{ ...intent, roleIds }] : [];
    });
}

interface ResourceRowProps {
    resource: ResourceDeclaration;
    categories: ResourceDeclaration[];
    roles: GuildRole[];
    declaredRoles: ResourceDeclaration[];
    disabled: boolean;
    onUpdate: (patch: Partial<ResourceDeclaration>) => void;
    onRemove: () => void;
}

function ResourceRow({
    resource,
    categories,
    roles,
    declaredRoles,
    disabled,
    onUpdate,
    onRemove,
}: ResourceRowProps) {
    // Roles do not live under categories, and the server rejects a role that names a
    // parent. Offering the control at all would invite a save that cannot succeed.
    const canHaveParent = resource.kind !== 'role' && categories.length > 0;
    const style = RESOURCE_KIND_STYLES[resource.kind];
    const KindIcon = style.icon;

    return (
        <Stack
            gap={8}
            p="xs"
            style={{
                background: 'var(--mantine-color-dark-7)',
                border: '1px solid var(--mantine-color-dark-5)',
                // The kind's colour down the edge of the row, so a list of resources
                // is scannable by kind without reading any of the labels.
                borderLeft: `3px solid var(--mantine-color-${style.color}-6)`,
                borderRadius: 6,
            }}
        >
            <Group gap={6} wrap="nowrap" justify="space-between">
                <Group gap={6} wrap="nowrap">
                    <KindIcon size={15} color={`var(--mantine-color-${style.color}-5)`} />
                    <Badge size="xs" variant="light" color={style.color}>
                        {style.label}
                    </Badge>
                    <Text size="12px" fw={600}>
                        {style.prefix}
                        {resource.defaultName}
                    </Text>
                </Group>
                <Tooltip label="Remove" withArrow>
                    <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="red"
                        onClick={onRemove}
                        disabled={disabled}
                        aria-label={`Remove ${resource.defaultName}`}
                    >
                        <IconTrash size={14} />
                    </ActionIcon>
                </Tooltip>
            </Group>

            <Group gap={6} wrap="nowrap" align="flex-start" grow>
                <TextInput
                    size="xs"
                    label="Name"
                    description="What it gets called when created."
                    value={resource.defaultName}
                    onChange={(event) => onUpdate({ defaultName: event.currentTarget.value })}
                    leftSection={
                        style.prefix ? (
                            <Text size="12px" c="dimmed">
                                {style.prefix}
                            </Text>
                        ) : undefined
                    }
                    disabled={disabled}
                />

                <TextInput
                    size="xs"
                    label="Key"
                    description="How this flow refers to it. A rename in Discord won't break it."
                    value={resource.key}
                    onChange={(event) => onUpdate({ key: event.currentTarget.value })}
                    disabled={disabled}
                />
            </Group>

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
                    comboboxProps={{ withinPortal: true }}
                />
            )}

            {/*
             * Roles carry no permission overwrites — overwrites are a property of a
             * channel or a category, and a role *appears in* them rather than having
             * them. Offering the editor here would be a form with no effect.
             */}
            {resource.kind !== 'role' && (
                <>
                    <Divider
                        label={
                            <Text size="10.5px" c="dimmed">
                                Who can see it
                            </Text>
                        }
                        labelPosition="left"
                    />
                    <PermissionIntentEditor
                        intents={resource.permissions}
                        onChange={(next) => onUpdate({ permissions: next })}
                        roles={roles}
                        declaredRoles={declaredRoles}
                        canInherit={Boolean(resource.parentKey)}
                        disabled={disabled}
                    />
                </>
            )}
        </Stack>
    );
}
