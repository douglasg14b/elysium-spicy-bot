/**
 * Declare the guild objects a flow needs — whether or not it already has them.
 *
 * This is the authoring surface for what provisioning installs. A resource declared
 * here is offered by the pickers immediately — the point of the whole feature is that
 * building a flow no longer requires creating its channels by hand first.
 *
 * A resource is one of two things and the panel says so up front: something to
 * **create**, or something that **already exists** and should be adopted. The second
 * is not a different kind of resource — it is the same declaration carrying an
 * `adoptDiscordId`, which the install plan turns into an `adopt` rather than a
 * `create`. Declaring "this flow needs #announcements, which we already have" was
 * unsayable before that field existed.
 *
 * The panel never says "journey". A flow's journey is implicit, keyed on the flow's
 * own id, so the operator declares what this flow needs and the scope follows from
 * that. Grouping several flows under one journey is deferred (PRD §5.8 item 39).
 *
 * It lives in a modal off the toolbar rather than in the right-hand column. That
 * column is for the *selected node's* configuration; a flow-wide concern sharing it
 * meant selecting a block showed nothing while resources were open. Permission
 * editing also wants more width than 300px.
 *
 * **Sizing is deliberate and is not sidebar density.** Everything here was `xs` with
 * 12px text while the panel lived in a 300px column; moving to a modal kept the
 * cramped sizing and made it hard to read on a normal monitor. Inputs are `sm` and
 * labels are default body size. Do not shrink them back.
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
import { IconLink, IconPlus, IconTrash } from '@tabler/icons-react';
import type {
    GuildChannel,
    GuildRole,
    PermissionIntent,
    ResourceDeclaration,
    ResourceKind,
} from '../api/types';
import { declaredRoleOptionValue } from './declaredRoleReference';
import { PermissionIntentEditor } from './PermissionIntentEditor';
import {
    adoptableChannelOptions,
    canAdoptFromChannelList,
    canHaveParent,
    declarationForAdoptedChannel,
    declarationForNewResource,
} from './resourceAdoption';
import { RESOURCE_KIND_ORDER, RESOURCE_KIND_STYLES } from './resourceMeta';

interface ResourcesPanelProps {
    resources: ResourceDeclaration[];
    onChange: (next: ResourceDeclaration[]) => void;
    /** Real roles in the guild, for permission rules that name one. */
    roles: GuildRole[];
    /** Real channels in the guild, so a resource can adopt one instead of creating it. */
    channels: GuildChannel[];
    /** Set while a save is in flight, so the panel cannot be edited mid-write. */
    saving?: boolean;
    /** A rejected save, shown verbatim — the server's message names the real problem. */
    error?: string;
}

/**
 * Which of the two ways of declaring a resource the add form is currently asking
 * about. Not a property of the resource — a declaration is the same shape either way.
 */
type DeclarationMode = 'create' | 'adopt';

export function ResourcesPanel({
    resources,
    onChange,
    roles,
    channels,
    saving,
    error,
}: ResourcesPanelProps) {
    const [pendingName, setPendingName] = useState('');
    // Kind is chosen before adding, not from a dropdown menu that hides the choice
    // behind a click. A wrong kind is otherwise silent until install.
    const [pendingKind, setPendingKind] = useState<ResourceKind>('textChannel');
    const [pendingParentKey, setPendingParentKey] = useState<string | null>(null);
    const [pendingMode, setPendingMode] = useState<DeclarationMode>('create');
    const [pendingAdoptId, setPendingAdoptId] = useState<string | null>(null);

    const categories = resources.filter((resource) => resource.kind === 'category');
    const declaredRoles = resources.filter((resource) => resource.kind === 'role');

    // The control disappears rather than offering a save that cannot work, or a value
    // the apply would silently ignore. See `canHaveParent`.
    const pendingCanHaveParent = canHaveParent(pendingKind) && categories.length > 0;

    // Only text channels can be adopted from the builder's channel list — see
    // `canAdoptFromChannelList`, which records why the other two kinds cannot.
    const pendingCanAdopt = canAdoptFromChannelList(pendingKind);
    const adoptOptions = adoptableChannelOptions(channels, pendingKind, resources);

    function addResource() {
        const declaration =
            pendingMode === 'adopt' && pendingAdoptId
                ? adoptedDeclaration(pendingAdoptId)
                : declarationForNewResource({
                      name: pendingName,
                      kind: pendingKind,
                      existing: resources,
                      parentKey: pendingCanHaveParent ? pendingParentKey : null,
                  });

        if (!declaration) return;

        onChange([...resources, declaration]);
        setPendingName('');
        setPendingParentKey(null);
        setPendingAdoptId(null);
    }

    function adoptedDeclaration(channelId: string): ResourceDeclaration | undefined {
        const channel = channels.find((candidate) => candidate.id === channelId);
        // The picker only offers ids from this list, so a miss means the list changed
        // under the selection. Adding nothing is better than adding a declaration
        // naming an id whose name we would have to guess.
        if (!channel) return undefined;

        return declarationForAdoptedChannel({
            channel,
            kind: pendingKind,
            existing: resources,
            parentKey: pendingCanHaveParent ? pendingParentKey : null,
        });
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

    const canAdd = pendingMode === 'adopt' ? Boolean(pendingAdoptId) : true;

    return (
        <Stack gap="lg">
            <Text c="dimmed">
                Channels and roles this flow needs. Declare them here and they show up in the
                pickers straight away — you can build the whole flow before any of them exist,
                or point one at something you already have.
            </Text>

            {error && (
                <Alert color="red" variant="light">
                    <Text>{error}</Text>
                </Alert>
            )}

            <Stack
                gap="sm"
                p="md"
                style={{
                    background: 'var(--mantine-color-dark-7)',
                    border: '1px solid var(--mantine-color-dark-5)',
                    borderRadius: 8,
                }}
            >
                <Text fw={700}>Add a resource</Text>

                <Group gap="sm" wrap="nowrap" align="flex-end">
                    <Button.Group>
                        {RESOURCE_KIND_ORDER.map((kind) => {
                            const style = RESOURCE_KIND_STYLES[kind];
                            const KindIcon = style.icon;
                            const active = pendingKind === kind;
                            return (
                                <Button
                                    key={kind}
                                    size="sm"
                                    variant={active ? 'filled' : 'default'}
                                    color={active ? style.color : undefined}
                                    leftSection={<KindIcon size={16} />}
                                    onClick={() => {
                                        setPendingKind(kind);
                                        // A pending parent or adoption that the new kind
                                        // cannot hold would be dropped at add time —
                                        // silently, since the control that set it is
                                        // about to disappear. Cleared here instead.
                                        if (!canHaveParent(kind)) setPendingParentKey(null);
                                        if (!canAdoptFromChannelList(kind)) {
                                            setPendingMode('create');
                                            setPendingAdoptId(null);
                                        }
                                    }}
                                    disabled={saving}
                                >
                                    {style.label}
                                </Button>
                            );
                        })}
                    </Button.Group>

                    {pendingCanAdopt && (
                        <Button.Group>
                            <Button
                                size="sm"
                                variant={pendingMode === 'create' ? 'filled' : 'default'}
                                color={pendingMode === 'create' ? 'brand' : undefined}
                                leftSection={<IconPlus size={16} />}
                                onClick={() => {
                                    setPendingMode('create');
                                    setPendingAdoptId(null);
                                }}
                                disabled={saving}
                            >
                                Create new
                            </Button>
                            <Button
                                size="sm"
                                variant={pendingMode === 'adopt' ? 'filled' : 'default'}
                                color={pendingMode === 'adopt' ? 'brand' : undefined}
                                leftSection={<IconLink size={16} />}
                                onClick={() => setPendingMode('adopt')}
                                disabled={saving}
                            >
                                Use existing
                            </Button>
                        </Button.Group>
                    )}
                </Group>

                <Group gap="sm" wrap="nowrap" align="flex-start">
                    {pendingMode === 'adopt' && pendingCanAdopt ? (
                        <Select
                            size="sm"
                            label="Which channel"
                            description="Start typing to find it. Its name and key are filled in for you."
                            placeholder="Search this server…"
                            data={adoptOptions}
                            value={pendingAdoptId}
                            onChange={setPendingAdoptId}
                            searchable
                            nothingFoundMessage={
                                adoptOptions.length === 0
                                    ? 'Every matching channel is already declared'
                                    : 'No match'
                            }
                            disabled={saving}
                            style={{ flex: 1 }}
                            comboboxProps={{ withinPortal: true }}
                        />
                    ) : (
                        <TextInput
                            label="Name"
                            description={`What it gets called when ${RESOURCE_KIND_STYLES[pendingKind].label.toLowerCase()} is created.`}
                            placeholder={RESOURCE_KIND_STYLES[pendingKind].namePlaceholder}
                            value={pendingName}
                            onChange={(event) => setPendingName(event.currentTarget.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') addResource();
                            }}
                            size="sm"
                            style={{ flex: 1 }}
                            disabled={saving}
                            leftSection={
                                RESOURCE_KIND_STYLES[pendingKind].prefix ? (
                                    <Text c="dimmed">
                                        {RESOURCE_KIND_STYLES[pendingKind].prefix}
                                    </Text>
                                ) : undefined
                            }
                        />
                    )}

                    {pendingCanHaveParent && (
                        <Select
                            size="sm"
                            label="Inside category"
                            description="Leave empty for top level."
                            placeholder="Top level"
                            data={categories.map((category) => ({
                                value: category.key,
                                label: category.defaultName,
                            }))}
                            value={pendingParentKey}
                            onChange={setPendingParentKey}
                            clearable
                            disabled={saving}
                            w={220}
                            comboboxProps={{ withinPortal: true }}
                        />
                    )}

                    <Button
                        size="sm"
                        variant="light"
                        leftSection={<IconPlus size={16} />}
                        onClick={addResource}
                        disabled={saving || !canAdd}
                        mt={26}
                    >
                        Add
                    </Button>
                </Group>
            </Stack>

            {resources.length === 0 ? (
                <Text c="dimmed" ta="center" pt="lg">
                    Nothing declared yet. If this flow only uses channels that already exist and
                    you have picked them on the blocks themselves, it doesn&apos;t need anything
                    here.
                </Text>
            ) : (
                <Stack gap="md">
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
                            channels={channels}
                            allResources={resources}
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
    channels: GuildChannel[];
    /** Every declared resource, so this row's picker can skip ones another row adopts. */
    allResources: ResourceDeclaration[];
    declaredRoles: ResourceDeclaration[];
    disabled: boolean;
    onUpdate: (patch: Partial<ResourceDeclaration>) => void;
    onRemove: () => void;
}

function ResourceRow({
    resource,
    categories,
    roles,
    channels,
    allResources,
    declaredRoles,
    disabled,
    onUpdate,
    onRemove,
}: ResourceRowProps) {
    const showParentPicker = canHaveParent(resource.kind) && categories.length > 0;
    const showAdoptPicker = canAdoptFromChannelList(resource.kind);
    const style = RESOURCE_KIND_STYLES[resource.kind];
    const KindIcon = style.icon;
    const adopting = Boolean(resource.adoptDiscordId);

    const adoptOptions = adoptableChannelOptions(
        channels,
        resource.kind,
        allResources,
        resource.key
    );

    return (
        <Stack
            gap="sm"
            p="md"
            style={{
                background: 'var(--mantine-color-dark-7)',
                border: '1px solid var(--mantine-color-dark-5)',
                // The kind's colour down the edge of the row, so a list of resources
                // is scannable by kind without reading any of the labels.
                borderLeft: `4px solid var(--mantine-color-${style.color}-6)`,
                borderRadius: 8,
            }}
        >
            <Group gap="sm" wrap="nowrap" justify="space-between">
                <Group gap="sm" wrap="nowrap">
                    <KindIcon size={20} color={`var(--mantine-color-${style.color}-5)`} />
                    <Badge size="md" variant="light" color={style.color}>
                        {style.label}
                    </Badge>
                    <Text fw={600} size="lg">
                        {style.prefix}
                        {resource.defaultName}
                    </Text>
                    {/*
                     * Create-versus-adopt is the one fact about a row that changes
                     * what install does to the server, and it is invisible in the
                     * name. Badged rather than left to the picker below, so a list
                     * of ten rows can be read without opening any of them.
                     */}
                    {adopting && (
                        <Badge
                            size="md"
                            variant="light"
                            color="teal"
                            leftSection={<IconLink size={12} />}
                        >
                            Already exists
                        </Badge>
                    )}
                </Group>
                <Tooltip label="Remove" withArrow>
                    <ActionIcon
                        size="lg"
                        variant="subtle"
                        color="red"
                        onClick={onRemove}
                        disabled={disabled}
                        aria-label={`Remove ${resource.defaultName}`}
                    >
                        <IconTrash size={18} />
                    </ActionIcon>
                </Tooltip>
            </Group>

            <Group gap="md" wrap="nowrap" align="flex-start" grow>
                <TextInput
                    size="sm"
                    label="Name"
                    description={
                        adopting
                            ? 'What it is called today. Install will not rename it.'
                            : 'What it gets called when created.'
                    }
                    value={resource.defaultName}
                    onChange={(event) => onUpdate({ defaultName: event.currentTarget.value })}
                    leftSection={
                        style.prefix ? <Text c="dimmed">{style.prefix}</Text> : undefined
                    }
                    disabled={disabled}
                />

                <TextInput
                    size="sm"
                    label="Key"
                    description="How this flow refers to it. A rename in Discord won't break it."
                    value={resource.key}
                    onChange={(event) => onUpdate({ key: event.currentTarget.value })}
                    disabled={disabled}
                />
            </Group>

            {showAdoptPicker && (
                <Select
                    size="sm"
                    label="Does it already exist?"
                    description={
                        adopting
                            ? 'Install will adopt this rather than creating anything. Clear it to create a new one instead.'
                            : 'Leave empty to create a new one. Pick a channel to adopt it instead.'
                    }
                    placeholder="No — create a new one"
                    data={adoptOptions}
                    value={resource.adoptDiscordId ?? null}
                    onChange={(next) => onUpdate({ adoptDiscordId: next ?? undefined })}
                    searchable
                    clearable
                    nothingFoundMessage="No match"
                    disabled={disabled}
                    comboboxProps={{ withinPortal: true }}
                    leftSection={
                        adopting ? (
                            <IconLink size={16} color="var(--mantine-color-teal-5)" />
                        ) : undefined
                    }
                />
            )}

            {showParentPicker && (
                <Select
                    size="sm"
                    label="Inside category"
                    description={
                        adopting
                            ? 'Only used if this is created after all. Adopting leaves it where it is.'
                            : 'Leave empty for top level.'
                    }
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
                        label={<Text c="dimmed">Who can see it</Text>}
                        labelPosition="left"
                    />
                    {/*
                     * Said once, here, rather than on every rule: `applyInstallPlan`
                     * only compiles overwrites on the *create* path, so an adopted
                     * channel keeps whatever permissions it already has. Rules left on
                     * the row would otherwise look applied and never be.
                     */}
                    {adopting && (
                        <Alert color="yellow" variant="light">
                            <Text size="sm">
                                Adopting keeps the permissions this channel already has —
                                install won&apos;t touch them. Rules below are saved but only
                                take effect if you switch back to creating it.
                            </Text>
                        </Alert>
                    )}
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
