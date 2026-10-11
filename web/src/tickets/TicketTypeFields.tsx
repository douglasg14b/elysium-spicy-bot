/**
 * The fields of one ticket type: label, channel name template, auto-claim, and who can do
 * what in the channel.
 *
 * Shared by the two places a ticket type is written — the tickets page's type editor, and
 * a journey declaring one in the Resources panel — so the type reads the same wherever it
 * is made and a fifth permission flag lands in both at once. The **key** is the caller's:
 * on the tickets page it is the type's own key, fixed once the type exists; in the panel
 * it is the resource key, which also names the type. It sits beside the label, so the
 * caller hands it in as `keyField`.
 */

import type { ReactNode, Ref } from 'react';
import { Checkbox, Group, Stack, Switch, Table, Text, TextInput } from '@mantine/core';
import type { TicketPermissionModel, TicketRolePermissions } from '../api/types';
import type { TicketTypeDraft, TicketTypeDraftProblems } from './ticketTypeForm';

/** The three people a ticket involves, in the order the permission grid shows them. */
const PERMISSION_SUBJECTS = [
    { key: 'subject', label: 'Subject', hint: 'Who the ticket is about' },
    { key: 'opener', label: 'Opener', hint: 'Whoever opened it, when a person did' },
    { key: 'staff', label: 'Staff', hint: 'Your moderation roles' },
] as const satisfies readonly { key: keyof TicketPermissionModel; label: string; hint: string }[];

/** The four channel permissions a type can grant, per person. */
const PERMISSION_FLAGS = [
    { key: 'view', label: 'View' },
    { key: 'send', label: 'Send' },
    { key: 'readHistory', label: 'History' },
    { key: 'manageMessages', label: 'Manage' },
] as const satisfies readonly { key: keyof TicketRolePermissions; label: string }[];

/*
 * `satisfies` above rejects a key that is not a member; these reject a member missing
 * from the list, which is the direction that actually bites — a fourth permission flag
 * would otherwise compile fine while the grid silently stopped offering a column.
 * Same mechanism as `TICKET_SUMMARY_KEYS` in `api/types.ts`.
 */
type PermissionTablesAreComplete =
    | Exclude<keyof TicketPermissionModel, (typeof PERMISSION_SUBJECTS)[number]['key']>
    | Exclude<keyof TicketRolePermissions, (typeof PERMISSION_FLAGS)[number]['key']>;

/** Do not delete as unused: removing it erases the guard above. */
const permissionTablesAreComplete: [PermissionTablesAreComplete] extends [never]
    ? true
    : ['A permission grid table is missing a key', PermissionTablesAreComplete] = true;

void permissionTablesAreComplete;

/** What these fields edit: a type without its key. */
export type TicketTypeFieldsValue = Omit<TicketTypeDraft, 'type'>;

interface TicketTypeFieldsProps {
    readonly value: TicketTypeFieldsValue;
    readonly onChange: (next: TicketTypeFieldsValue) => void;
    readonly problems?: Pick<TicketTypeDraftProblems, 'label' | 'nameTemplate'>;
    /** The key input, drawn beside the label. */
    readonly keyField: ReactNode;
    /** Focus the label when the fields first show — a new type, whose label is the first thing to fill. */
    readonly autoFocusLabel?: boolean;
    /** For a caller that moves focus to the label itself (the panel's jump-to-field). */
    readonly labelRef?: Ref<HTMLInputElement>;
}

export function TicketTypeFields({
    value,
    onChange,
    problems,
    keyField,
    autoFocusLabel,
    labelRef,
}: TicketTypeFieldsProps) {
    return (
        <Stack gap="md">
            <Group grow align="flex-start">
                {keyField}
                <TextInput
                    ref={labelRef}
                    label="Label"
                    description="What an operator picks out of a list."
                    placeholder="Support"
                    data-autofocus={autoFocusLabel ? true : undefined}
                    value={value.label}
                    error={problems?.label}
                    onChange={(event) => onChange({ ...value, label: event.currentTarget.value })}
                />
            </Group>

            <TextInput
                label="Channel name template"
                description="Only {{####}}, {{subject}} and {{opener}} render. Anything else arrives in Discord as literal braces."
                placeholder="T{{####}}-{{subject}}"
                value={value.nameTemplate}
                error={problems?.nameTemplate}
                onChange={(event) => onChange({ ...value, nameTemplate: event.currentTarget.value })}
            />

            <Switch
                label="Claim it automatically when it opens"
                description="For types where whoever opened it is already handling it."
                checked={value.autoClaimOnOpen}
                onChange={(event) => onChange({ ...value, autoClaimOnOpen: event.currentTarget.checked })}
            />

            <div>
                <Text fw={700} size="14px">
                    Who can do what in the channel
                </Text>
                <Text size="12.5px" c="dimmed" mb="xs" maw={560}>
                    Take <Text span fw={600}>View</Text> away and the rest is academic — they cannot see the
                    channel to use it.
                </Text>
                <PermissionGrid
                    permissions={value.permissions}
                    onChange={(permissions) => onChange({ ...value, permissions })}
                />
            </div>
        </Stack>
    );
}

/**
 * The permission model as three rows of four checkboxes.
 *
 * A grid rather than twelve labelled switches: the question an operator is answering is
 * "who can send here", and that is only readable when the three people sit in one column
 * next to each other.
 */
function PermissionGrid({
    permissions,
    onChange,
}: {
    permissions: TicketPermissionModel;
    onChange: (permissions: TicketPermissionModel) => void;
}) {
    return (
        <Table withTableBorder verticalSpacing="xs" horizontalSpacing="sm">
            <Table.Thead>
                <Table.Tr>
                    <Table.Th />
                    {PERMISSION_FLAGS.map((flag) => (
                        <Table.Th key={flag.key} w={92} ta="center">
                            <Text size="11.5px" fw={700}>
                                {flag.label}
                            </Text>
                        </Table.Th>
                    ))}
                </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
                {PERMISSION_SUBJECTS.map((subject) => (
                    <Table.Tr key={subject.key}>
                        <Table.Td>
                            <Text size="13px" fw={600}>
                                {subject.label}
                            </Text>
                            <Text size="11.5px" c="dark.2">
                                {subject.hint}
                            </Text>
                        </Table.Td>
                        {PERMISSION_FLAGS.map((flag) => (
                            <Table.Td key={flag.key} ta="center">
                                <Checkbox
                                    aria-label={`${subject.label} can ${flag.label.toLowerCase()}`}
                                    checked={permissions[subject.key][flag.key]}
                                    onChange={(event) =>
                                        onChange({
                                            ...permissions,
                                            [subject.key]: {
                                                ...permissions[subject.key],
                                                [flag.key]: event.currentTarget.checked,
                                            },
                                        })
                                    }
                                    style={{ display: 'inline-flex' }}
                                />
                            </Table.Td>
                        ))}
                    </Table.Tr>
                ))}
            </Table.Tbody>
        </Table>
    );
}
