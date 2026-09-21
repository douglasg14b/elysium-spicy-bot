/**
 * Edit one resource's permission intents: the `audience × access` grid, as rows.
 *
 * This surfaces the model that already exists in
 * `src/features/provisioning/logic/permissionIntent.ts`. It adds nothing to it —
 * four audiences, three access levels, applied in order — because the grid was built
 * in 5A to express exactly the cases this editor has to offer.
 *
 * **Order is load-bearing and therefore visible.** `compilePermissionIntents` lets a
 * later intent win per-id, so "hidden from everyone, then readWrite for this role" is
 * two rows whose sequence *is* the meaning. Reordering controls are not decoration
 * here: without them the second row can never be written after the first.
 *
 * Three things the model says that the UI has to keep saying:
 *
 *  - **No permissions at all is not an empty list.** Absent means "inherit from the
 *    parent category", which is the useful default for a channel in a category; an
 *    empty array clears inheritance and grants nothing. The editor keeps these
 *    distinct — removing the last row removes the key rather than leaving `[]`.
 *  - **`staff` takes no role ids.** Staff roles are supplied per install, which is
 *    what keeps a journey portable across guilds. Asking for ids here would bake this
 *    guild's ids into the declaration.
 *  - **`subject` is a per-run fact.** A journey declaring one cannot be installed as
 *    shared guild structure at all (`journeyNeedsSubject`). It is offered anyway,
 *    with the consequence stated on the row — see `SUBJECT_IS_OFFERED` below.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import {
    ActionIcon,
    Alert,
    Badge,
    Button,
    Group,
    MultiSelect,
    Select,
    Stack,
    Text,
    Tooltip,
} from '@mantine/core';
import {
    IconArrowDown,
    IconArrowUp,
    IconEye,
    IconEyeOff,
    IconPencil,
    IconPlus,
    IconTrash,
} from '@tabler/icons-react';
import type {
    GuildRole,
    PermissionAccess,
    PermissionAudience,
    PermissionIntent,
    ResourceDeclaration,
} from '../api/types';
import { roleColorHex } from './nodeMeta';
import { RESOURCE_KIND_STYLES } from './resourceMeta';
import { declaredRoleOptionValue, parseDeclaredRoleReference } from './declaredRoleReference';

/**
 * `subject` is offered, with a warning rather than a hidden option.
 *
 * The alternative — omitting it — was rejected. The audience is a real part of the
 * model (a ticket-shaped room is a subject intent plus a staff intent), and an
 * editor that silently cannot express one of four documented audiences is a second,
 * narrower model an author has to discover by its absence. Offering it with the
 * consequence written on the row tells the truth once; hiding it means the author
 * asks why the docs mention a fourth audience.
 *
 * The consequence is real and is surfaced by `journeyNeedsSubject`: a journey with a
 * subject intent cannot be installed as shared guild structure, because there is no
 * member to resolve it against at install time.
 */
const SUBJECT_IS_OFFERED = true;

const AUDIENCE_LABEL: Record<PermissionAudience, string> = {
    everyone: 'Everyone',
    roles: 'Specific roles',
    staff: 'Staff',
    subject: 'The member it is about',
};

const AUDIENCE_HINT: Record<PermissionAudience, string> = {
    everyone: "The @everyone role — the server's default for anyone with no other rule.",
    roles: 'Roles you name. Pick from this server, or from the roles this flow declares.',
    staff: "This server's moderator roles, supplied when you install. No ids are stored here, which is what lets the same flow install on another server.",
    subject: 'The specific member the resource is about — a per-run fact, not a server one.',
};

interface AccessStyle {
    label: string;
    color: string;
    icon: typeof IconEye;
    hint: string;
}

const ACCESS_STYLES: Record<PermissionAccess, AccessStyle> = {
    hidden: {
        label: 'Hidden',
        color: 'red',
        icon: IconEyeOff,
        hint: 'Cannot see it at all.',
    },
    readOnly: {
        label: 'Read only',
        color: 'yellow',
        icon: IconEye,
        hint: 'Can see and read. Cannot post, reply in threads, or react.',
    },
    readWrite: {
        label: 'Read & write',
        color: 'green',
        icon: IconPencil,
        hint: 'Can see, post, reply in threads, and react.',
    },
};

const AUDIENCE_ORDER: readonly PermissionAudience[] = ['everyone', 'roles', 'staff', 'subject'];
const ACCESS_ORDER: readonly PermissionAccess[] = ['hidden', 'readOnly', 'readWrite'];

interface PermissionIntentEditorProps {
    /** Absent means "inherit from the parent category" and is not the same as `[]`. */
    intents: PermissionIntent[] | undefined;
    /** `undefined` removes the key; an empty array clears inheritance. */
    onChange: (next: PermissionIntent[] | undefined) => void;
    /** Real roles in the guild. */
    roles: GuildRole[];
    /** Roles this journey declares — referenced by key, resolved at install. */
    declaredRoles: ResourceDeclaration[];
    /** Whether this resource can inherit at all. A role or a top-level channel cannot. */
    canInherit: boolean;
    disabled: boolean;
    /**
     * Scroll one numbered rule into view, for a chip that named it.
     *
     * A `ruleNamesNoRole` or `perRunOnly` chip complains about a *specific* rule, and
     * the shortest path to it is the whole point of the chip being clickable. The index
     * is passed rather than a ref because only this component knows how its rows are
     * built; the caller handing down a ref per rule would have made it own the shape of
     * a list it does not render.
     *
     * Optional, and ignored when the editor is showing the "inherits" empty state —
     * there is no rule to reach.
     */
    focusRuleIndex?: number;
}

export function PermissionIntentEditor({
    intents,
    onChange,
    roles,
    declaredRoles,
    canInherit,
    disabled,
    focusRuleIndex,
}: PermissionIntentEditorProps) {
    const focusedRuleRef = useRef<HTMLDivElement>(null);

    /**
     * Scroll the rule a chip named into view.
     *
     * **Scrolled now when the row exists, deferred only when it does not.** The caller
     * clears its pending-jump state as soon as it has dispatched, which flips
     * `focusRuleIndex` back to `undefined` and re-runs this effect — so a cleanup that
     * cancelled a queued frame would cancel the very scroll it was queued for. Acting
     * synchronously when the element is already mounted takes that race off the table;
     * the deferred path remains for the first open, where `Collapse` has not mounted
     * the row yet and there is nothing to scroll to.
     */
    useEffect(() => {
        if (focusRuleIndex === undefined) return;

        if (focusedRuleRef.current) {
            focusedRuleRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
            return;
        }

        const handle = window.requestAnimationFrame(() => {
            focusedRuleRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });

        return () => window.cancelAnimationFrame(handle);
    }, [focusRuleIndex]);

    const roleOptions = useMemo(() => {
        const declared = declaredRoles.map((resource) => ({
            value: declaredRoleOptionValue(resource.key),
            label: `@${resource.defaultName}`,
        }));
        const existing = [...roles]
            .sort((first, second) => second.position - first.position)
            .map((role) => ({ value: role.id, label: `@${role.name}` }));

        return declared.length > 0
            ? [
                  { group: 'Declared by this flow — created on install', items: declared },
                  { group: 'Roles in this server', items: existing },
              ]
            : existing;
    }, [roles, declaredRoles]);

    function updateIntent(index: number, patch: Partial<PermissionIntent>) {
        onChange(
            (intents ?? []).map((intent, position) =>
                position === index ? { ...intent, ...patch } : intent
            )
        );
    }

    function removeIntent(index: number) {
        const next = (intents ?? []).filter((_intent, position) => position !== index);
        // Removing the last row restores inheritance rather than leaving `[]`, which
        // would mean something different: an empty array clears inherited overwrites.
        // An author removing their only rule means "never mind", not "grant nothing".
        onChange(next.length > 0 ? next : undefined);
    }

    function moveIntent(index: number, delta: number) {
        const current = intents ?? [];
        const target = index + delta;
        if (target < 0 || target >= current.length) return;
        const next = [...current];
        const [moved] = next.splice(index, 1);
        if (!moved) return;
        next.splice(target, 0, moved);
        onChange(next);
    }

    function addIntent() {
        // `everyone` + `hidden` is the first row of nearly every real case — a channel
        // is made private and then opened to something. Starting there means the
        // common case is one click plus one row rather than two edits.
        onChange([...(intents ?? []), { audience: 'everyone', access: 'hidden' }]);
    }

    if (!intents) {
        return (
            <Stack gap={6}>
                <Text size="11px" c="dimmed">
                    {canInherit
                        ? 'Inherits its category’s permissions. Add a rule to override them.'
                        : 'Uses the server’s default permissions. Add a rule to restrict it.'}
                </Text>
                <Button
                    size="compact-xs"
                    variant="light"
                    leftSection={<IconPlus size={13} />}
                    onClick={addIntent}
                    disabled={disabled}
                    w="fit-content"
                >
                    Add a permission rule
                </Button>
            </Stack>
        );
    }

    return (
        <Stack gap={6}>
            {intents.length === 0 && (
                <Alert color="yellow" variant="light" p={6}>
                    <Text size="11px">
                        No rules, and inheritance is cleared — nobody but the bot and admins
                        will see this. Remove the list entirely to inherit instead.
                    </Text>
                </Alert>
            )}

            {intents.map((intent, index) => (
                <IntentRow
                    // Position, not content: two rows can hold identical values, and a
                    // content key would make them collide and remount on every edit.
                    key={index}
                    intent={intent}
                    index={index}
                    total={intents.length}
                    roleOptions={roleOptions}
                    roles={roles}
                    declaredRoles={declaredRoles}
                    disabled={disabled}
                    onUpdate={(patch) => updateIntent(index, patch)}
                    onRemove={() => removeIntent(index)}
                    onMove={(delta) => moveIntent(index, delta)}
                    rowRef={index === focusRuleIndex ? focusedRuleRef : undefined}
                />
            ))}

            <Group gap={6}>
                <Button
                    size="compact-xs"
                    variant="light"
                    leftSection={<IconPlus size={13} />}
                    onClick={addIntent}
                    disabled={disabled}
                >
                    Add rule
                </Button>
                <Button
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    onClick={() => onChange(undefined)}
                    disabled={disabled}
                >
                    {canInherit ? 'Back to inheriting' : 'Clear all rules'}
                </Button>
            </Group>

            {intents.length > 1 && (
                <Text size="10.5px" c="dimmed">
                    Applied top to bottom — a later rule wins over an earlier one for the same
                    role or member.
                </Text>
            )}
        </Stack>
    );
}

/** One entry in the role picker: a flat option, or a labelled group of them. */
type RoleOption = { value: string; label: string };
type RoleOptionData = RoleOption[] | { group: string; items: RoleOption[] }[];

interface IntentRowProps {
    intent: PermissionIntent;
    index: number;
    total: number;
    roleOptions: RoleOptionData;
    roles: GuildRole[];
    declaredRoles: ResourceDeclaration[];
    disabled: boolean;
    onUpdate: (patch: Partial<PermissionIntent>) => void;
    onRemove: () => void;
    onMove: (delta: number) => void;
    /** Set on the one row a chip jumped to, so it can be scrolled into view. */
    rowRef?: RefObject<HTMLDivElement>;
}

function IntentRow({
    intent,
    index,
    total,
    roleOptions,
    roles,
    declaredRoles,
    disabled,
    onUpdate,
    onRemove,
    onMove,
    rowRef,
}: IntentRowProps) {
    const access = ACCESS_STYLES[intent.access];
    const AccessIcon = access.icon;

    // A declared role reference is a key wearing a `resource:` prefix, so it never
    // collides with a snowflake. Split for the warning below, not for storage.
    const declaredReferences = (intent.roleIds ?? [])
        .map(parseDeclaredRoleReference)
        .filter((key): key is string => key !== undefined);

    const unknownDeclared = declaredReferences.filter(
        (key) => !declaredRoles.some((resource) => resource.key === key)
    );

    return (
        <Stack
            ref={rowRef}
            gap={6}
            p={6}
            style={{
                background: 'var(--mantine-color-dark-6)',
                border: '1px solid var(--mantine-color-dark-4)',
                borderRadius: 5,
            }}
        >
            <Group gap={4} wrap="nowrap" align="center">
                <Badge size="xs" variant="default" c="dimmed" px={5}>
                    {index + 1}
                </Badge>

                <Select
                    size="xs"
                    data={AUDIENCE_ORDER.filter(
                        (audience) => SUBJECT_IS_OFFERED || audience !== 'subject'
                    ).map((audience) => ({ value: audience, label: AUDIENCE_LABEL[audience] }))}
                    value={intent.audience}
                    onChange={(next) => {
                        if (!next) return;
                        const audience = next as PermissionAudience;
                        // Role ids are meaningless on every audience but `roles`, and
                        // the server's schema only requires them there. Dropping them
                        // on the way out means a switch to `staff` and back does not
                        // resurrect a stale list the author cannot see.
                        onUpdate({
                            audience,
                            roleIds: audience === 'roles' ? (intent.roleIds ?? []) : undefined,
                        });
                    }}
                    disabled={disabled}
                    allowDeselect={false}
                    style={{ flex: 1, minWidth: 0 }}
                    comboboxProps={{ withinPortal: true }}
                />

                <Select
                    size="xs"
                    data={ACCESS_ORDER.map((level) => ({
                        value: level,
                        label: ACCESS_STYLES[level].label,
                    }))}
                    value={intent.access}
                    onChange={(next) => next && onUpdate({ access: next as PermissionAccess })}
                    disabled={disabled}
                    allowDeselect={false}
                    w={110}
                    leftSection={<AccessIcon size={13} color={`var(--mantine-color-${access.color}-5)`} />}
                    comboboxProps={{ withinPortal: true }}
                />

                <Tooltip label="Move up" withArrow>
                    <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="gray"
                        onClick={() => onMove(-1)}
                        disabled={disabled || index === 0}
                        aria-label="Move rule up"
                    >
                        <IconArrowUp size={13} />
                    </ActionIcon>
                </Tooltip>
                <Tooltip label="Move down" withArrow>
                    <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="gray"
                        onClick={() => onMove(1)}
                        disabled={disabled || index === total - 1}
                        aria-label="Move rule down"
                    >
                        <IconArrowDown size={13} />
                    </ActionIcon>
                </Tooltip>
                <Tooltip label="Remove rule" withArrow>
                    <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="red"
                        onClick={onRemove}
                        disabled={disabled}
                        aria-label="Remove rule"
                    >
                        <IconTrash size={13} />
                    </ActionIcon>
                </Tooltip>
            </Group>

            {intent.audience === 'roles' && (
                <MultiSelect
                    size="xs"
                    placeholder="Pick at least one role"
                    data={roleOptions}
                    value={[...(intent.roleIds ?? [])]}
                    onChange={(next) => onUpdate({ roleIds: next })}
                    disabled={disabled}
                    searchable
                    nothingFoundMessage="No roles found"
                    comboboxProps={{ withinPortal: true }}
                    error={
                        (intent.roleIds?.length ?? 0) === 0
                            ? 'Name at least one role, or use Everyone.'
                            : undefined
                    }
                    renderOption={({ option }) => {
                        const role = roles.find((candidate) => candidate.id === option.value);
                        return (
                            <Group gap={6} wrap="nowrap">
                                <span
                                    style={{
                                        width: 9,
                                        height: 9,
                                        borderRadius: '50%',
                                        display: 'block',
                                        flexShrink: 0,
                                        background: role
                                            ? roleColorHex(role.color)
                                            : `var(--mantine-color-${RESOURCE_KIND_STYLES.role.color}-5)`,
                                    }}
                                />
                                <Text size="12px">{option.label}</Text>
                            </Group>
                        );
                    }}
                />
            )}

            {intent.audience === 'roles' && declaredReferences.length > 0 && (
                <Text size="10.5px" c="dimmed">
                    {declaredReferences.length === 1 ? 'One role is' : `${declaredReferences.length} roles are`}{' '}
                    declared by this flow and will be created before this resource.
                </Text>
            )}

            {unknownDeclared.length > 0 && (
                <Alert color="red" variant="light" p={5}>
                    <Text size="10.5px">
                        References {unknownDeclared.map((key) => `"${key}"`).join(', ')}, which this
                        flow no longer declares. Install will refuse this.
                    </Text>
                </Alert>
            )}

            <Text size="10.5px" c="dimmed">
                {AUDIENCE_HINT[intent.audience]} {access.hint}
            </Text>

            {intent.audience === 'subject' && (
                <Alert color="yellow" variant="light" p={5}>
                    <Text size="10.5px">
                        A subject is the member a resource is about, which only exists while a
                        flow runs. A flow declaring one cannot be installed as shared server
                        structure.
                    </Text>
                </Alert>
            )}
        </Stack>
    );
}
