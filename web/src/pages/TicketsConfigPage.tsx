/**
 * Ticket configuration: the three categories, who moderates, and the declared types.
 *
 * **Saved on a button, never on a keystroke.** Every input here is a text field an
 * operator types into, and a save-per-character both floods the API and — with a
 * `disabled` on the input while it flies — steals focus mid-word under HTML's focus fixup
 * rule. Buttons carry `loading`; inputs stay enabled.
 *
 * **Type deletion refusals are the server's.** `DELETE .../types/:type` answers 409 while
 * any ticket holds the type and names the counts and example numbers in the refusal; that
 * sentence is shown verbatim and the dialog stays open, because it names the thing the
 * operator now has to go and deal with. Same arrangement as `JourneysListPage.handleDelete`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Alert,
    Badge,
    Button,
    Card,
    Center,
    Checkbox,
    Group,
    Loader,
    Modal,
    MultiSelect,
    Stack,
    Switch,
    Table,
    Text,
    TextInput,
    Title,
    Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
    IconAlertTriangle,
    IconCategory,
    IconCheck,
    IconPencil,
    IconPlus,
    IconTicket,
    IconTrash,
} from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import { getGuildRoles } from '../api/flows';
import {
    deleteTicketType,
    getTicketsConfig,
    saveTicketType,
    updateTicketsConfig,
} from '../api/tickets';
import type {
    GuildRole,
    TicketPermissionModel,
    TicketRolePermissions,
    TicketTypeView,
    TicketingConfigView,
} from '../api/types';
import {
    draftFromType,
    emptyTicketTypeDraft,
    isTicketTypeDraftValid,
    validateTicketTypeDraft,
    type TicketTypeDraft,
} from '../tickets/ticketTypeForm';
import { useGuilds } from '../guilds/GuildContext';
import { PAGE_MAX_WIDTH } from '../theme';

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

/** The category names and moderation roles, as the form holds them before a save. */
interface CategoriesDraft {
    readonly supportTicketCategoryName: string;
    readonly claimedTicketCategoryName: string;
    readonly closedTicketCategoryName: string;
    readonly moderationRoles: string[];
}

function categoriesFromConfig(config: TicketingConfigView): CategoriesDraft {
    return {
        supportTicketCategoryName: config.supportTicketCategoryName,
        claimedTicketCategoryName: config.claimedTicketCategoryName,
        closedTicketCategoryName: config.closedTicketCategoryName,
        moderationRoles: config.moderationRoleIds,
    };
}

export function TicketsConfigPage() {
    const { selected, loading: guildsLoading } = useGuilds();

    const [config, setConfig] = useState<TicketingConfigView | null>(null);
    const [roles, setRoles] = useState<GuildRole[]>([]);
    const [categories, setCategories] = useState<CategoriesDraft | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [savingCategories, setSavingCategories] = useState(false);

    const [editing, setEditing] = useState<TicketTypeDraft | null>(null);
    /*
     * Whether the modal is editing something that already exists. The key is identity —
     * the path parameter a save writes to — so it is fixed once a type has one, and
     * `draft.type` being non-empty is not the same question: a half-typed new key is also
     * non-empty.
     */
    const [editingExisting, setEditingExisting] = useState(false);
    const [savingType, setSavingType] = useState(false);

    const [pendingDelete, setPendingDelete] = useState<TicketTypeView | null>(null);
    const [deleting, setDeleting] = useState(false);

    const guildId = selected?.id;

    const refresh = useCallback(async () => {
        if (!guildId) return;
        setError(null);
        try {
            const loaded = await getTicketsConfig(guildId);
            setConfig(loaded);
            // The categories draft is reset from the server's answer on every reload. A
            // draft preserved across a refresh would quietly present stale text as the
            // operator's unsaved edit.
            setCategories(categoriesFromConfig(loaded));
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Failed to load ticket settings');
        }
    }, [guildId]);

    useEffect(() => {
        if (!guildId) return;
        let cancelled = false;
        void (async () => {
            setLoading(true);
            setError(null);
            try {
                const [loadedConfig, guildRoles] = await Promise.all([
                    getTicketsConfig(guildId),
                    getGuildRoles(guildId),
                ]);
                if (cancelled) return;
                setConfig(loadedConfig);
                setCategories(categoriesFromConfig(loadedConfig));
                setRoles(guildRoles);
            } catch (err) {
                const message =
                    err instanceof ApiError ? err.message : 'Failed to load ticket settings';
                if (!cancelled) setError(message);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [guildId]);

    /*
     * Live roles, plus any saved id that no longer resolves to one. Without the second
     * half a deleted role vanishes from the control while staying in the saved list, and
     * the next save drops it with nothing on screen having said so. Same reasoning as
     * `ServerSettingsPage`.
     */
    const { roleOptions, orphanedRoleIds } = useMemo(() => {
        const known = roles.map((role) => ({ value: role.id, label: role.name }));
        const knownIds = new Set(roles.map((role) => role.id));
        const orphanedIds = (categories?.moderationRoles ?? []).filter(
            (roleId) => !knownIds.has(roleId)
        );
        return {
            roleOptions: [
                ...known,
                ...orphanedIds.map((roleId) => ({
                    value: roleId,
                    label: `Deleted role (${roleId})`,
                })),
            ],
            orphanedRoleIds: orphanedIds,
        };
    }, [roles, categories?.moderationRoles]);

    async function handleSaveCategories() {
        if (!guildId || !categories) return;
        setSavingCategories(true);
        try {
            const updated = await updateTicketsConfig(guildId, {
                supportTicketCategoryName: categories.supportTicketCategoryName,
                claimedTicketCategoryName: categories.claimedTicketCategoryName,
                closedTicketCategoryName: categories.closedTicketCategoryName,
                moderationRoles: categories.moderationRoles,
            });
            setConfig(updated);
            setCategories(categoriesFromConfig(updated));
            notifications.show({
                color: 'brand',
                title: 'Saved',
                message: 'Categories and moderation roles updated.',
            });
        } catch (err) {
            const message = err instanceof ApiError ? err.message : "Couldn't save that.";
            notifications.show({ color: 'red', title: "Couldn't save", message });
        } finally {
            setSavingCategories(false);
        }
    }

    function openNewType(): void {
        setEditing(emptyTicketTypeDraft());
        setEditingExisting(false);
    }

    function openExistingType(type: TicketTypeView): void {
        setEditing(draftFromType(type));
        setEditingExisting(true);
    }

    async function handleSaveType() {
        if (!guildId || !editing) return;
        setSavingType(true);
        try {
            const updated = await saveTicketType(guildId, editing.type.trim(), {
                label: editing.label.trim(),
                nameTemplate: editing.nameTemplate.trim(),
                permissions: editing.permissions,
                autoClaimOnOpen: editing.autoClaimOnOpen,
            });
            setConfig(updated);
            setCategories(categoriesFromConfig(updated));
            setEditing(null);
            notifications.show({
                color: 'brand',
                title: 'Saved',
                message: `“${editing.label.trim()}” is on the menu.`,
            });
        } catch (err) {
            // The server re-checks every rule the client does and its refusal is the one
            // that is true at the moment of the attempt, so it is shown as written.
            const message = err instanceof ApiError ? err.message : "Couldn't save that type.";
            notifications.show({ color: 'red', title: "Couldn't save", message });
        } finally {
            setSavingType(false);
        }
    }

    async function handleDeleteType() {
        if (!guildId || !pendingDelete) return;
        setDeleting(true);
        try {
            await deleteTicketType(guildId, pendingDelete.type);
            notifications.show({
                color: 'brand',
                title: 'Gone',
                message: `“${pendingDelete.label}” is no longer something anybody can open.`,
            });
            setPendingDelete(null);
            await refresh();
        } catch (err) {
            // Verbatim: the 409 names how many tickets still hold the type and a few of
            // their numbers, which is exactly what has to be dealt with first.
            const message = err instanceof ApiError ? err.message : "Couldn't delete that type.";
            notifications.show({
                color: 'red',
                title: "Couldn't delete",
                message,
                autoClose: false,
            });
            // Left open when the refusal names something to go and fix.
            if (!(err instanceof ApiError) || err.status !== 409) setPendingDelete(null);
            await refresh();
        } finally {
            setDeleting(false);
        }
    }

    if (guildsLoading) {
        return (
            <Center mih="60vh">
                <Loader color="brand" />
            </Center>
        );
    }

    if (!selected) {
        return (
            <Alert color="gray" title="No server">
                The bot isn&apos;t in any server you can manage.
            </Alert>
        );
    }

    const problems = editing ? validateTicketTypeDraft(editing) : {};

    return (
        <Stack gap="lg" maw={PAGE_MAX_WIDTH}>
            <div>
                <Text size="12.5px" c="dark.2">
                    <Text span c="dark.1" fw={600}>
                        {selected.name}
                    </Text>{' '}
                    › Configure ›{' '}
                    <Text span c="dark.2">
                        <Link to="/tickets" style={{ color: 'inherit' }}>
                            Tickets
                        </Link>
                    </Text>{' '}
                    › Settings
                </Text>
                <Group gap={10} mt={4}>
                    <IconTicket size={22} color="var(--mantine-color-brand-6)" />
                    <Title order={1} size="24px">
                        Ticket settings
                    </Title>
                </Group>
                <Text c="dimmed" size="13.5px" mt={4} maw={600}>
                    Where tickets live, who gets to read them, and what kinds a member can open.
                </Text>
            </div>

            {loading ? (
                <Center py="xl">
                    <Loader color="brand" size="sm" />
                </Center>
            ) : error ? (
                <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Couldn't load settings">
                    {error}
                </Alert>
            ) : !config || !categories ? null : (
                <>
                    {/*
                     * Not configured is a state to act on, not a reason to hide the page —
                     * an operator may well be here precisely to set tickets up, and the
                     * only thing that creates the config row is the Discord command.
                     */}
                    {!config.configured && (
                        <Alert
                            color="yellow"
                            icon={<IconAlertTriangle size={16} />}
                            title="Tickets aren't set up here yet"
                        >
                            Run <Text span ff="monospace">/deploy-ticket-system</Text> in Discord
                            first. That creates the categories and the panel members press; until it
                            has run there is no config row for anything below to save into.
                        </Alert>
                    )}

                    <Card p="xl">
                        <Group gap={8} mb={4}>
                            <IconCategory size={18} color="var(--mantine-color-brand-6)" />
                            <Text fw={700} size="15px">
                                Categories and moderators
                            </Text>
                        </Group>
                        <Text c="dimmed" size="13px" mb="lg" maw={560}>
                            A ticket moves between these three categories as it is claimed and
                            closed. Name them something you can actually find in a long channel
                            list.
                        </Text>

                        <Stack gap="md" maw={520}>
                            <TextInput
                                label="Open tickets"
                                description="Where a fresh ticket lands."
                                value={categories.supportTicketCategoryName}
                                onChange={(event) =>
                                    setCategories({
                                        ...categories,
                                        supportTicketCategoryName: event.currentTarget.value,
                                    })
                                }
                            />
                            <TextInput
                                label="Claimed tickets"
                                description="Where it goes once somebody owns it."
                                value={categories.claimedTicketCategoryName}
                                onChange={(event) =>
                                    setCategories({
                                        ...categories,
                                        claimedTicketCategoryName: event.currentTarget.value,
                                    })
                                }
                            />
                            <TextInput
                                label="Closed tickets"
                                description="Where it rests. Closed is not deleted."
                                value={categories.closedTicketCategoryName}
                                onChange={(event) =>
                                    setCategories({
                                        ...categories,
                                        closedTicketCategoryName: event.currentTarget.value,
                                    })
                                }
                            />
                            <MultiSelect
                                label="Moderation roles"
                                description="Who can claim, close and read every ticket. Separate from staff roles — mods and staff aren't the same crowd here."
                                placeholder={
                                    categories.moderationRoles.length ? undefined : 'Pick one or more roles'
                                }
                                data={roleOptions}
                                value={categories.moderationRoles}
                                onChange={(value) =>
                                    setCategories({ ...categories, moderationRoles: value })
                                }
                                searchable
                                clearable
                                nothingFoundMessage="No roles found"
                            />
                            {/*
                             * Said up front rather than discovered as a 400. A saved role
                             * that no longer exists in Discord is kept in the control on
                             * purpose — dropping it silently would lose what was saved —
                             * but the server refuses any save containing one, including a
                             * save that only renames a category. So the operator is told
                             * which it is and what to do, before they press the button.
                             */}
                            {orphanedRoleIds.length > 0 && (
                                <Alert
                                    color="yellow"
                                    icon={<IconAlertTriangle size={16} />}
                                    title="One of these roles no longer exists"
                                >
                                    Discord has never heard of{' '}
                                    <Text span ff="monospace">
                                        {orphanedRoleIds.join(', ')}
                                    </Text>{' '}
                                    any more, and the server refuses to save a config that
                                    mentions it — even if all you changed was a category name.
                                    Remove it above first.
                                </Alert>
                            )}
                            <Group>
                                <Button
                                    color="brand"
                                    loading={savingCategories}
                                    onClick={() => void handleSaveCategories()}
                                >
                                    Save changes
                                </Button>
                            </Group>
                        </Stack>
                    </Card>

                    <Card p={0} style={{ overflow: 'hidden' }}>
                        <Group justify="space-between" align="flex-end" p="md" wrap="wrap">
                            <div>
                                <Text fw={700} size="15px">
                                    Ticket types
                                </Text>
                                <Text c="dimmed" size="13px" mt={2} maw={560}>
                                    The kinds of ticket a member can open. Each one names its
                                    channel and decides who can see inside.
                                </Text>
                            </div>
                            <Button
                                color="brand"
                                leftSection={<IconPlus size={16} />}
                                onClick={openNewType}
                            >
                                Add type
                            </Button>
                        </Group>

                        {config.types.length === 0 ? (
                            <Stack align="center" gap={6} py={40} px="md">
                                <IconTicket size={28} color="var(--mantine-color-dark-3)" />
                                <Text fw={700} size="15px">
                                    No types declared
                                </Text>
                                <Text c="dimmed" size="13px" ta="center" maw={420}>
                                    With nothing declared, nobody can open a ticket at all — the
                                    panel has no options to offer. Add at least one.
                                </Text>
                            </Stack>
                        ) : (
                            <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
                                <Table.Thead>
                                    <Table.Tr>
                                        <Table.Th>Label</Table.Th>
                                        <Table.Th w={150}>Key</Table.Th>
                                        <Table.Th>Channel name</Table.Th>
                                        <Table.Th w={120}>Auto-claim</Table.Th>
                                        <Table.Th w={110} />
                                    </Table.Tr>
                                </Table.Thead>
                                <Table.Tbody>
                                    {config.types.map((type) => (
                                        <Table.Tr key={type.type}>
                                            <Table.Td>
                                                <Text fw={600} size="13.5px">
                                                    {type.label}
                                                </Text>
                                            </Table.Td>
                                            <Table.Td>
                                                <Text ff="monospace" size="12px" c="dark.2">
                                                    {type.type}
                                                </Text>
                                            </Table.Td>
                                            <Table.Td>
                                                <Text ff="monospace" size="12px" c="dark.1">
                                                    {type.nameTemplate}
                                                </Text>
                                            </Table.Td>
                                            <Table.Td>
                                                {type.autoClaimOnOpen ? (
                                                    <Badge
                                                        variant="light"
                                                        color="brand"
                                                        radius="sm"
                                                        leftSection={<IconCheck size={11} />}
                                                    >
                                                        On open
                                                    </Badge>
                                                ) : (
                                                    <Text size="12px" c="dark.2">
                                                        Off
                                                    </Text>
                                                )}
                                            </Table.Td>
                                            <Table.Td>
                                                <Group gap={6} justify="flex-end" wrap="nowrap">
                                                    <Tooltip label="Edit type">
                                                        <Button
                                                            size="xs"
                                                            variant="subtle"
                                                            color="gray"
                                                            px={8}
                                                            onClick={() => openExistingType(type)}
                                                            aria-label={`Edit ${type.label}`}
                                                        >
                                                            <IconPencil size={14} />
                                                        </Button>
                                                    </Tooltip>
                                                    <Tooltip label="Delete type">
                                                        <Button
                                                            size="xs"
                                                            variant="subtle"
                                                            color="red"
                                                            px={8}
                                                            onClick={() => setPendingDelete(type)}
                                                            aria-label={`Delete ${type.label}`}
                                                        >
                                                            <IconTrash size={14} />
                                                        </Button>
                                                    </Tooltip>
                                                </Group>
                                            </Table.Td>
                                        </Table.Tr>
                                    ))}
                                </Table.Tbody>
                            </Table>
                        )}
                    </Card>
                </>
            )}

            <Modal
                opened={editing !== null}
                onClose={() => setEditing(null)}
                title={editingExisting ? 'Edit ticket type' : 'New ticket type'}
                size="lg"
            >
                {editing && (
                    <Stack gap="md">
                        <Group grow align="flex-start">
                            <TextInput
                                label="Key"
                                description={
                                    editingExisting
                                        ? 'Identity — every existing ticket points at it, so it cannot change.'
                                        : 'Lowercase, no spaces. Goes in channel names and flow options.'
                                }
                                placeholder="support"
                                // Disabled only because it is not editable at all when
                                // editing — not because a save is in flight. Nothing in
                                // this modal disables an input the operator is typing into.
                                disabled={editingExisting}
                                value={editing.type}
                                error={problems.type}
                                onChange={(event) =>
                                    setEditing({ ...editing, type: event.currentTarget.value })
                                }
                            />
                            <TextInput
                                label="Label"
                                description="What an operator picks out of a list."
                                placeholder="Support"
                                data-autofocus={editingExisting ? undefined : true}
                                value={editing.label}
                                error={problems.label}
                                onChange={(event) =>
                                    setEditing({ ...editing, label: event.currentTarget.value })
                                }
                            />
                        </Group>

                        <TextInput
                            label="Channel name template"
                            description="Only {{####}}, {{subject}} and {{opener}} render. Anything else arrives in Discord as literal braces."
                            placeholder="T{{####}}-{{subject}}"
                            value={editing.nameTemplate}
                            error={problems.nameTemplate}
                            onChange={(event) =>
                                setEditing({ ...editing, nameTemplate: event.currentTarget.value })
                            }
                        />

                        <Switch
                            label="Claim it automatically when it opens"
                            description="For types where whoever opened it is already handling it."
                            checked={editing.autoClaimOnOpen}
                            onChange={(event) =>
                                setEditing({
                                    ...editing,
                                    autoClaimOnOpen: event.currentTarget.checked,
                                })
                            }
                        />

                        <div>
                            <Text fw={700} size="14px">
                                Who can do what in the channel
                            </Text>
                            <Text size="12.5px" c="dimmed" mb="xs" maw={560}>
                                Take <Text span fw={600}>View</Text> away and the rest is academic —
                                they cannot see the channel to use it.
                            </Text>
                            <PermissionGrid
                                permissions={editing.permissions}
                                onChange={(permissions) => setEditing({ ...editing, permissions })}
                            />
                        </div>

                        <Group justify="flex-end" gap="sm">
                            <Button
                                variant="subtle"
                                color="gray"
                                onClick={() => setEditing(null)}
                                disabled={savingType}
                            >
                                Cancel
                            </Button>
                            <Button
                                color="brand"
                                loading={savingType}
                                disabled={!isTicketTypeDraftValid(editing)}
                                onClick={() => void handleSaveType()}
                            >
                                Save type
                            </Button>
                        </Group>
                    </Stack>
                )}
            </Modal>

            <Modal
                opened={pendingDelete !== null}
                onClose={() => setPendingDelete(null)}
                title="Delete ticket type"
                size="md"
            >
                <Stack gap="md">
                    <Text size="13.5px" c="dimmed">
                        <Text span fw={700} c="bright">
                            {pendingDelete?.label}
                        </Text>{' '}
                        (
                        <Text span ff="monospace">
                            {pendingDelete?.type}
                        </Text>
                        ) will stop being something anybody can open. Existing tickets keep the key
                        and lose their label — and the server refuses this outright while any ticket
                        still holds it, deleted ones included.
                    </Text>
                    <Group justify="flex-end" gap="sm">
                        <Button
                            variant="subtle"
                            color="gray"
                            onClick={() => setPendingDelete(null)}
                            disabled={deleting}
                        >
                            Cancel
                        </Button>
                        <Button color="red" loading={deleting} onClick={() => void handleDeleteType()}>
                            Delete type
                        </Button>
                    </Group>
                </Stack>
            </Modal>
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
