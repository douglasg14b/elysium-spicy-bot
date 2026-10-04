/**
 * Ticket configuration: the three category slots, who moderates, and the declared types.
 *
 * Each category slot is an existing category picked by id, or a name the bot creates on
 * save (`tickets/categorySlots.ts`). This is the only place categories are chosen; the
 * Discord config modal sets moderation roles only.
 *
 * **Saved on a button, never on a keystroke.** Every input here is a text field an
 * operator types into, and a save-per-character both floods the API and — with a
 * `disabled` on the input while it flies — steals focus mid-word under HTML's focus fixup
 * rule. Buttons carry `loading`; inputs stay enabled.
 *
 * **The type editor checks a draft against the server's own rules**, through the zod the
 * SDK generates from the save route, and shows the server's own sentence under the field
 * before Save is pressed. Nothing here restates a rule. The two that need the server's
 * renderer arrive as the refusal on Save.
 *
 * **Type deletion refusals are the server's.** `DELETE .../types/:type` answers 409 while
 * any ticket holds the type and names the counts and example numbers in the refusal; that
 * sentence is shown verbatim and the dialog stays open, because it names the thing the
 * operator now has to go and deal with. Same arrangement as `JourneysListPage.handleDelete`.
 */

import { useMemo, useState } from 'react';
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    ApiError,
    deleteTicketTypeMutation,
    getGuildChannelsOptions,
    getGuildChannelsQueryKey,
    getGuildRolesOptions,
    getTicketsConfigOptions,
    getTicketsConfigQueryKey,
    saveTicketTypeMutation,
    updateTicketsConfigMutation,
    zSaveTicketTypeBody,
    zSaveTicketTypePath,
    type TicketingConfigView,
    type TicketPermissionModel,
    type TicketRolePermissions,
    type TicketTypeView,
} from '@brattybot/web-sdk';
import { Link } from 'react-router-dom';
import { fieldProblems } from '../api/fieldProblems';
import {
    categorySlotProblem,
    choiceFromDraft,
    draftFromView,
    TICKET_CATEGORY_SLOTS,
    type CategorySlotDraft,
    type TicketCategorySlot,
} from '../tickets/categorySlots';
import { TicketCategorySlotField } from '../tickets/TicketCategorySlotField';
import {
    draftFromType,
    emptyTicketTypeDraft,
    ticketTypeRequest,
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
 * would otherwise compile fine while the grid silently stopped offering a column. The
 * types are the SDK's, generated from the server's schemas, so a flag added there is a
 * compile error here.
 */
type PermissionTablesAreComplete =
    | Exclude<keyof TicketPermissionModel, (typeof PERMISSION_SUBJECTS)[number]['key']>
    | Exclude<keyof TicketRolePermissions, (typeof PERMISSION_FLAGS)[number]['key']>;

/** Do not delete as unused: removing it erases the guard above. */
const permissionTablesAreComplete: [PermissionTablesAreComplete] extends [never]
    ? true
    : ['A permission grid table is missing a key', PermissionTablesAreComplete] = true;

void permissionTablesAreComplete;

/** The category slots and moderation roles, as the form holds them before a save. */
interface CategoriesDraft {
    readonly slots: Readonly<Record<TicketCategorySlot, CategorySlotDraft>>;
    readonly moderationRoles: string[];
}

function categoriesFromConfig(config: TicketingConfigView): CategoriesDraft {
    return {
        slots: {
            open: draftFromView(config.categories.open),
            claimed: draftFromView(config.categories.claimed),
            closed: draftFromView(config.categories.closed),
        },
        moderationRoles: config.moderationRoleIds,
    };
}

export function TicketsConfigPage() {
    const { selected, loading: guildsLoading } = useGuilds();

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

            {/* Keyed by server, so switching servers drops every draft and open dialog. */}
            <TicketsConfigForm key={selected.id} guildId={selected.id} />
        </Stack>
    );
}

interface TicketsConfigFormProps {
    readonly guildId: string;
}

/** Everything below the header for one server: loads the config, edits it, saves it. */
function TicketsConfigForm({ guildId }: TicketsConfigFormProps) {
    const queryClient = useQueryClient();
    const configQuery = useQuery(getTicketsConfigOptions({ path: { guildId } }));
    const rolesQuery = useQuery(getGuildRolesOptions({ path: { guildId } }));
    // Channels too: a save may create a category, which the picker must then offer.
    const channelsQuery = useQuery(getGuildChannelsOptions({ path: { guildId } }));

    const configKey = getTicketsConfigQueryKey({ path: { guildId } });
    const channelsKey = getGuildChannelsQueryKey({ path: { guildId } });

    /*
     * `undefined` until the operator edits a slot or the roles: the form shows what is
     * saved. Dropped whenever the page re-reads after a categories save, so a draft never
     * presents stale text as the operator's unsaved edit.
     */
    const [categoriesDraft, setCategoriesDraft] = useState<CategoriesDraft>();

    const [editing, setEditing] = useState<TicketTypeDraft | null>(null);
    /*
     * Whether the modal is editing something that already exists. The key is identity —
     * the path parameter a save writes to — so it is fixed once a type has one, and
     * `draft.type` being non-empty is not the same question: a half-typed new key is also
     * non-empty.
     */
    const [editingExisting, setEditingExisting] = useState(false);
    const [pendingDelete, setPendingDelete] = useState<TicketTypeView | null>(null);

    /*
     * A config read still in flight would land after a save and put the old config back,
     * so a save cancels it. A cancelled read leaves the cache as it was before that read,
     * so a save that is then refused — and so writes no answer into the cache — re-reads.
     */
    const cancelConfigReads = () => queryClient.cancelQueries({ queryKey: configKey });
    const rereadConfig = () => queryClient.invalidateQueries({ queryKey: configKey });

    const saveCategories = useMutation({
        ...updateTicketsConfigMutation(),
        onMutate: cancelConfigReads,
        onError: rereadConfig,
    });
    const saveType = useMutation({ ...saveTicketTypeMutation(), onMutate: cancelConfigReads, onError: rereadConfig });
    const deleteType = useMutation({
        ...deleteTicketTypeMutation(),
        // Re-read whatever the answer, and before the mutation settles, so the dialog's
        // button stays busy until the table is current. A refused delete re-reads too: the
        // refusal may be about a config another editor just changed.
        onSettled: () => queryClient.invalidateQueries({ queryKey: configKey }),
    });

    const config = configQuery.data;
    const roles = rolesQuery.data?.roles;
    const channels = channelsQuery.data?.channels;
    const categories = categoriesDraft ?? (config ? categoriesFromConfig(config) : undefined);

    /*
     * Live roles, plus any saved id that no longer resolves to one. Without the second
     * half a deleted role vanishes from the control while staying in the saved list, and
     * the next save drops it with nothing on screen having said so. Same reasoning as
     * `ServerSettingsPage`.
     */
    const { roleOptions, orphanedRoleIds } = useMemo(() => {
        const guildRoles = roles ?? [];
        const known = guildRoles.map((role) => ({ value: role.id, label: role.name }));
        const knownIds = new Set(guildRoles.map((role) => role.id));
        const orphanedIds = (categories?.moderationRoles ?? []).filter((roleId) => !knownIds.has(roleId));
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

    /**
     * Re-read the config and the channel list, then show the form what the server now holds.
     *
     * Only once both reads land. A failed read would otherwise reset the form to the
     * config from before the save — a category the save did make would read as unbound,
     * inviting the operator to make it twice — so the draft stays, and the failure says so.
     */
    async function rereadSettings(): Promise<void> {
        try {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: configKey }, { throwOnError: true }),
                queryClient.invalidateQueries({ queryKey: channelsKey }, { throwOnError: true }),
            ]);
        } catch (err) {
            notifications.show({
                color: 'red',
                title: "Couldn't re-read the settings",
                message: `${err instanceof ApiError ? err.message : 'The settings did not load.'} Reload the page before saving again — some of that save may have landed.`,
                autoClose: false,
            });
            return;
        }
        setCategoriesDraft(undefined);
    }

    async function handleSaveCategories() {
        if (!config || !categories) return;
        const problem = TICKET_CATEGORY_SLOTS.map((slot) => categorySlotProblem(categories.slots[slot])).find(Boolean);
        if (problem) {
            notifications.show({ color: 'red', title: "Couldn't save", message: problem });
            return;
        }

        let reread = false;
        try {
            const updated = await saveCategories.mutateAsync({
                path: { guildId },
                body: {
                    categories: {
                        open: choiceFromDraft(categories.slots.open, config.categories.open),
                        claimed: choiceFromDraft(categories.slots.claimed, config.categories.claimed),
                        closed: choiceFromDraft(categories.slots.closed, config.categories.closed),
                    },
                    moderationRoles: categories.moderationRoles,
                },
            });
            queryClient.setQueryData(configKey, updated);
            setCategoriesDraft(undefined);
            notifications.show({
                color: 'brand',
                title: 'Saved',
                message: 'Categories and moderation roles updated.',
            });
            // The save may have created categories the picker must now offer.
            await queryClient.invalidateQueries({ queryKey: channelsKey });
        } catch (err) {
            const message = err instanceof ApiError ? err.message : "Couldn't save that.";
            notifications.show({ color: 'red', title: "Couldn't save", message, autoClose: false });
            // 502 (one create failed, the rest saved) and 503 (made in Discord, not
            // recorded) both leave the draft describing something that is no longer true —
            // and a draft still in "create" mode invites making the same category twice.
            if (err instanceof ApiError && (err.status === 502 || err.status === 503)) reread = true;
        }
        // Outside the `try`, so a failed re-read cannot report a save that went through as
        // "Couldn't save".
        if (reread) await rereadSettings();
    }

    function openNewType(): void {
        setEditing(emptyTicketTypeDraft());
        setEditingExisting(false);
    }

    function openExistingType(type: TicketTypeView): void {
        setEditing(draftFromType(type));
        setEditingExisting(true);
    }

    /*
     * The draft as it will be sent, checked against the save route's own rules. The key is
     * the path's to check and the rest the body's; each problem is the server's sentence
     * for the first rule that field breaks.
     */
    const typeRequest = editing ? ticketTypeRequest(editing) : null;
    const typeProblems = typeRequest
        ? {
              ...fieldProblems(zSaveTicketTypePath.safeParse({ guildId, type: typeRequest.type })),
              ...fieldProblems(zSaveTicketTypeBody.safeParse(typeRequest.body)),
          }
        : {};
    const typeIsSendable = Object.keys(typeProblems).length === 0;

    async function handleSaveType() {
        if (!typeRequest || !typeIsSendable) return;
        try {
            const updated = await saveType.mutateAsync({
                path: { guildId, type: typeRequest.type },
                body: typeRequest.body,
            });
            queryClient.setQueryData(configKey, updated);
            setEditing(null);
            notifications.show({
                color: 'brand',
                title: 'Saved',
                message: `“${typeRequest.body.label}” is on the menu.`,
            });
        } catch (err) {
            // The server is the authority, and its refusal is the one that is true at the
            // moment of the attempt — including the renderer's checks the form cannot make —
            // so it is shown as written.
            const message = err instanceof ApiError ? err.message : "Couldn't save that type.";
            notifications.show({ color: 'red', title: "Couldn't save", message });
        }
    }

    async function handleDeleteType() {
        if (!pendingDelete) return;
        try {
            await deleteType.mutateAsync({ path: { guildId, type: pendingDelete.type } });
            notifications.show({
                color: 'brand',
                title: 'Gone',
                message: `“${pendingDelete.label}” is no longer something anybody can open.`,
            });
            setPendingDelete(null);
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
        }
    }

    /*
     * An error wins over the spinner, so one refused load is shown at once rather than
     * after the others settle — but only while something is still missing. A failed
     * background refetch keeps the form, and the operator's draft, on screen.
     */
    const loadError = configQuery.error ?? rolesQuery.error ?? channelsQuery.error;
    if (loadError && !(config && roles && channels)) {
        return (
            <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Couldn't load settings">
                {loadError instanceof ApiError ? loadError.message : 'Failed to load ticket settings'}
            </Alert>
        );
    }

    if (!config || !roles || !channels || !categories) {
        return (
            <Center py="xl">
                <Loader color="brand" size="sm" />
            </Center>
        );
    }

    return (
        <>
            {/*
             * Not configured is a state to act on, not a reason to hide the page —
             * an operator may well be here precisely to set tickets up, and the
             * only thing that creates the config row is the Discord command.
             */}
            {!config.configured && (
                <Alert color="yellow" icon={<IconAlertTriangle size={16} />} title="Tickets aren't set up here yet">
                    {config.deployed ? (
                        <>
                            Link all three categories and pick your moderation roles below.
                            Tickets stay paused until every category is linked to a real
                            one.
                        </>
                    ) : (
                        <>
                            Run <Text span ff="monospace">/deploy-ticket-system</Text> in
                            Discord first. That posts the panel members press and creates
                            the config everything below saves into; then come back and
                            choose the categories here.
                        </>
                    )}
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
                    closed. Pick ones you already have, or name new ones and the bot makes
                    them. Renaming them in Discord later is fine; the bot follows the
                    category, not its name.
                </Text>

                <Stack gap="md" maw={520}>
                    {TICKET_CATEGORY_SLOTS.map((slot) => (
                        <TicketCategorySlotField
                            key={slot}
                            slot={slot}
                            view={config.categories[slot]}
                            channels={channels}
                            draft={categories.slots[slot]}
                            onChange={(draft) =>
                                setCategoriesDraft({
                                    ...categories,
                                    slots: { ...categories.slots, [slot]: draft },
                                })
                            }
                        />
                    ))}
                    <MultiSelect
                        label="Moderation roles"
                        description="Who can claim, close and read every ticket. Separate from staff roles — mods and staff aren't the same crowd here."
                        placeholder={categories.moderationRoles.length ? undefined : 'Pick one or more roles'}
                        data={roleOptions}
                        value={categories.moderationRoles}
                        onChange={(value) => setCategoriesDraft({ ...categories, moderationRoles: value })}
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
                            mentions it — even if all you changed was a category.
                            Remove it above first.
                        </Alert>
                    )}
                    <Group>
                        <Button
                            color="brand"
                            loading={saveCategories.isPending}
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
                    <Button color="brand" leftSection={<IconPlus size={16} />} onClick={openNewType}>
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
                    // `ScrollContainer`, matching the tickets list: the card's own
                    // `overflow: hidden` would otherwise squeeze every column on a
                    // narrow viewport rather than let the excess scroll, which is how
                    // "On open" ended up clipped even at 120px on a desktop width that
                    // was never actually narrow — the column was simply too tight.
                    <Table.ScrollContainer minWidth={900}>
                    {/*
                     * `layout="fixed"` for the same reason the tickets list needs it:
                     * a long, guild-authored label is one unbroken word as far as the
                     * browser's `auto` table layout is concerned, and it will borrow
                     * width from `Key`/`Auto-claim` to make room unless the columns
                     * are fixed and each cell handles its own overflow.
                     */}
                    <Table layout="fixed" verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>Label</Table.Th>
                                <Table.Th w={150}>Key</Table.Th>
                                <Table.Th>Channel name</Table.Th>
                                <Table.Th w={150}>Auto-claim</Table.Th>
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
                    </Table.ScrollContainer>
                )}
            </Card>

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
                                error={typeProblems.type}
                                onChange={(event) => setEditing({ ...editing, type: event.currentTarget.value })}
                            />
                            <TextInput
                                label="Label"
                                description="What an operator picks out of a list."
                                placeholder="Support"
                                data-autofocus={editingExisting ? undefined : true}
                                value={editing.label}
                                error={typeProblems.label}
                                onChange={(event) => setEditing({ ...editing, label: event.currentTarget.value })}
                            />
                        </Group>

                        {/*
                         * The one place the browser names the tokens, as a hint before
                         * typing; the rule and its refusal are the server's. Follows
                         * `SUPPORTED_TOKENS` in `src/features/tickets/logic/ticketTypeRules.ts`.
                         */}
                        <TextInput
                            label="Channel name template"
                            description="Only {{####}}, {{subject}} and {{opener}} render. Anything else won't save."
                            placeholder="T{{####}}-{{subject}}"
                            value={editing.nameTemplate}
                            error={typeProblems.nameTemplate}
                            onChange={(event) => setEditing({ ...editing, nameTemplate: event.currentTarget.value })}
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
                                disabled={saveType.isPending}
                            >
                                Cancel
                            </Button>
                            <Button
                                color="brand"
                                loading={saveType.isPending}
                                disabled={!typeIsSendable}
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
                            disabled={deleteType.isPending}
                        >
                            Cancel
                        </Button>
                        <Button color="red" loading={deleteType.isPending} onClick={() => void handleDeleteType()}>
                            Delete type
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </>
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
