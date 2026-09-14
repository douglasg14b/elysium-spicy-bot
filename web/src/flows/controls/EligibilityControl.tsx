/**
 * Who may do this — one control over one object-valued key.
 *
 * The first control whose value is neither a scalar nor a list of them, and the
 * reason it is one control rather than three fields: the principal decides which
 * extra input exists at all, and the field vocabulary has no way to say "show
 * this field only when that one is set". Three always-visible fields, two of them
 * dead for any given choice, is the form that produces graphs holding a role list
 * under a `subject` gate.
 *
 * Every edit emits a **whole new gate object**, never a mutation: the value lands
 * in React state via `updateNodeConfig`, which compares by reference.
 */

import { useMemo } from 'react';
import { MultiSelect, Select, Stack, Text, TextInput } from '@mantine/core';
import {
    ELIGIBILITY_PERMISSIONS,
    ELIGIBILITY_PRINCIPALS,
    type EligibilityPermission,
    type Eligibility,
    type EligibilityPrincipal,
    type BlockConfigField,
} from '../../api/types';
import { roleColorHex } from '../nodeMeta';
import type { ControlProps } from './types';

type EligibilityField = Extract<BlockConfigField, { control: 'eligibility' }>;

/**
 * What each principal is called, and what choosing it actually does.
 *
 * Written from the author's side rather than the engine's: an author picking
 * "Only the person it's about" is not thinking about `FlowRunSeed.subject`.
 */
/*
 * Keyed by principal rather than a plain array, so adding one to the vocabulary
 * fails to compile here until it is given a label and a hint.
 *
 * Worth the shape. The drift test compares the principal *lists* as data, so a
 * new arm does force the browser constant to gain the string — but nothing would
 * force this table, and a principal with no entry renders a picker whose current
 * value has no option, which reads as unset.
 */
const PRINCIPAL_COPY: Record<EligibilityPrincipal, { label: string; hint: string }> = {
    anyone: { label: 'Anyone', hint: 'Nobody is turned away.' },
    subject: {
        label: "Only the person it's about",
        hint: 'The member this run is for. On a trigger there is no run yet, so this turns everyone away.',
    },
    actor: {
        label: 'Only whoever set it going',
        hint: 'The member who caused this step. On a trigger there is no run yet, so this turns everyone away.',
    },
    roles: { label: 'Anyone with one of these roles', hint: 'Holding any one of them is enough.' },
    discordPermission: {
        label: 'Anyone with one of these permissions',
        hint: 'Their effective server permissions, so an admin passes whatever their roles say.',
    },
    variable: {
        label: 'Whoever a saved value names',
        hint: 'A variable an earlier block stored a member id in.',
    },
};

/** The picker's options, in the order an author is most likely to want them. */
const PRINCIPAL_ORDER: readonly EligibilityPrincipal[] = [
    'anyone',
    'subject',
    'actor',
    'roles',
    'discordPermission',
    'variable',
];

/**
 * The gate a principal starts as when it is first chosen.
 *
 * Switching principal cannot carry the old one's extra across — a role list is
 * not a variable name — so each arm needs a starting value, and every arm with
 * an extra starts *empty*. An empty one is invalid, which is the honest state:
 * the author has chosen a gate and not yet said who, and the save refuses it
 * rather than silently storing a gate that admits nobody.
 */
function gateFor(principal: EligibilityPrincipal, previous: Eligibility): Eligibility {
    switch (principal) {
        case 'anyone':
        case 'subject':
        case 'actor':
            return { principal };
        case 'roles':
            return { principal, roleIds: previous.principal === 'roles' ? previous.roleIds : [] };
        case 'discordPermission':
            return {
                principal,
                permissions: previous.principal === 'discordPermission' ? previous.permissions : [],
            };
        case 'variable':
            return { principal, variable: previous.principal === 'variable' ? previous.variable : '' };
    }
}

/**
 * Narrow a stored value to a gate, falling back to the open one.
 *
 * A node whose `eligibility` key holds something else got there through an API the
 * schema rejects — but the control still has to render *something*, and showing
 * the open gate is the least surprising of the bad options: it matches what an
 * absent key means, and the author's next edit writes a valid gate over it.
 *
 * Deliberately **not** how the engine reads the same key. `readEligibility`
 * refuses an unreadable gate rather than opening it, because there the cost of
 * guessing wrong is admitting somebody. Here the cost is a mis-drawn form.
 *
 * The principal is narrowed against the vocabulary **before** the switch, so the
 * switch itself can be exhaustive with no `default`. That ordering is the point:
 * a `default` would silently absorb a principal added to the vocabulary and no
 * arm here, rendering a real gate as the open one — and the author's next save
 * would write that open gate over what they actually set.
 */
function asGate(value: unknown): Eligibility {
    if (!value || typeof value !== 'object') return { principal: 'anyone' };

    const known: readonly string[] = ELIGIBILITY_PRINCIPALS;
    const raw = (value as { principal?: unknown }).principal;
    if (typeof raw !== 'string' || !known.includes(raw)) return { principal: 'anyone' };
    const principal = raw as EligibilityPrincipal;

    switch (principal) {
        case 'anyone':
            return { principal: 'anyone' };
        case 'subject':
        case 'actor':
            return { principal };
        case 'roles': {
            const { roleIds } = value as { roleIds?: unknown };
            return {
                principal: 'roles',
                roleIds: Array.isArray(roleIds) ? roleIds.filter((id): id is string => typeof id === 'string') : [],
            };
        }
        case 'discordPermission': {
            const { permissions } = value as { permissions?: unknown };
            return {
                principal: 'discordPermission',
                permissions: narrowPermissions(permissions),
            };
        }
        case 'variable': {
            const { variable } = value as { variable?: unknown };
            return { principal: 'variable', variable: typeof variable === 'string' ? variable : '' };
        }
    }
}

/**
 * Keep only the permission names this build knows.
 *
 * Used on both directions — reading a stored rule and taking Mantine's plain
 * `string[]` back off the picker. One function rather than a filter on the way in
 * and a cast on the way out: the cast was safe by inspection only, which is the
 * kind of safe that stops being true when somebody edits the picker's `data`.
 */
function narrowPermissions(values: unknown): EligibilityPermission[] {
    const known: readonly string[] = ELIGIBILITY_PERMISSIONS;
    return Array.isArray(values)
        ? values.filter((name): name is EligibilityPermission =>
              typeof name === 'string' && known.includes(name)
          )
        : [];
}

/** The principal picker, plus whatever that principal needs. */
export function EligibilityControl({ field, value, onChange, context }: ControlProps<EligibilityField>) {
    const gate = asGate(value);
    const { hint } = PRINCIPAL_COPY[gate.principal];

    // Highest roles first, as Discord itself lists them — matching the single
    // role picker, so the same role is in the same place in both.
    const roleOptions = useMemo(
        () =>
            [...context.roles]
                .sort((first, second) => second.position - first.position)
                .map((role) => ({ value: role.id, label: `@${role.name}` })),
        [context.roles]
    );

    const chosenRoleColours = useMemo(
        () =>
            gate.principal === 'roles'
                ? gate.roleIds
                      .map((roleId) => context.roles.find((role) => role.id === roleId))
                      .filter((role): role is NonNullable<typeof role> => Boolean(role))
                : [],
        [gate, context.roles]
    );

    return (
        <Stack gap={6}>
            <Select
                label={field.label}
                description={field.description}
                data={PRINCIPAL_ORDER.map((principal) => ({
                    value: principal,
                    label: PRINCIPAL_COPY[principal].label,
                }))}
                value={gate.principal}
                onChange={(next) => {
                    // `null` only when the select is cleared, which `allowDeselect={false}`
                    // prevents — keep the current gate rather than inventing one.
                    if (next) onChange(gateFor(next as EligibilityPrincipal, gate));
                }}
                allowDeselect={false}
            />

            {/*
              * The empty state of each arm is an `error`, not a placeholder.
              *
              * Choosing a principal writes its arm immediately, with the extra
              * empty — and an empty extra is a rule the schema refuses, by
              * design: the alternative was storing a rule that admits nobody. But
              * the save-time refusal is a toast naming a generated node id, so
              * without this the author's only warning is one they have to decode
              * after the fact. Saying it at the field is what makes "fails in the
              * builder rather than in front of a member" true.
              */}
            {gate.principal === 'roles' && (
                <MultiSelect
                    placeholder="Pick at least one role"
                    error={gate.roleIds.length === 0 ? 'Pick at least one role, or this will not save.' : undefined}
                    data={roleOptions}
                    value={gate.roleIds}
                    onChange={(roleIds) => onChange({ principal: 'roles', roleIds })}
                    searchable
                    nothingFoundMessage="No roles found"
                />
            )}

            {/*
             * The chosen roles' own colours, under the picker rather than in it.
             * Mantine's MultiSelect renders its pills itself, so this is the place
             * a colour can be shown at all — and without it an author picking
             * between three similarly-named roles has nothing to tell them apart,
             * which the single role picker solves with its leading dot.
             */}
            {chosenRoleColours.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {chosenRoleColours.map((role) => (
                        <span
                            key={role.id}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        >
                            <span
                                style={{
                                    width: 9,
                                    height: 9,
                                    borderRadius: '50%',
                                    display: 'block',
                                    background: roleColorHex(role.color),
                                }}
                            />
                            <Text size="11px" c="dimmed">
                                {role.name}
                            </Text>
                        </span>
                    ))}
                </div>
            )}

            {gate.principal === 'discordPermission' && (
                <MultiSelect
                    placeholder="Pick at least one permission"
                    error={
                        gate.permissions.length === 0
                            ? 'Pick at least one permission, or this will not save.'
                            : undefined
                    }
                    data={ELIGIBILITY_PERMISSIONS.map((permission) => ({
                        value: permission,
                        label: readablePermission(permission),
                    }))}
                    value={gate.permissions}
                    onChange={(permissions) =>
                        // Mantine hands back plain strings. Narrowed through the
                        // same function the read path uses rather than cast,
                        // so the picker's `data` is not a thing to keep in step.
                        onChange({ principal: 'discordPermission', permissions: narrowPermissions(permissions) })
                    }
                    searchable
                    nothingFoundMessage="No permissions found"
                />
            )}

            {gate.principal === 'variable' && (
                <TextInput
                    placeholder="e.g. nominatedMember"
                    error={gate.variable ? undefined : 'Name a saved value, or this will not save.'}
                    value={gate.variable}
                    onChange={(event) =>
                        onChange({ principal: 'variable', variable: event.currentTarget.value })
                    }
                />
            )}

            {hint && (
                <Text size="11.5px" c="dimmed">
                    {hint}
                </Text>
            )}
        </Stack>
    );
}

/** `ManageGuild` → `Manage Guild`, so the dropdown reads like Discord's own. */
function readablePermission(permission: EligibilityPermission): string {
    return permission.replace(/([a-z])([A-Z])/g, '$1 $2');
}
