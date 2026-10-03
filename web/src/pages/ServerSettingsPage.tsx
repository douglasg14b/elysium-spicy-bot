import { useMemo, useState } from 'react';
import {
    Alert,
    Button,
    Card,
    Center,
    Group,
    Loader,
    MultiSelect,
    Stack,
    Text,
    Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconSettings, IconUsersGroup } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    ApiError,
    getGuildRolesOptions,
    getGuildSettingsOptions,
    getGuildSettingsQueryKey,
    updateGuildSettingsMutation,
} from '@brattybot/web-sdk';
import { useGuilds } from '../guilds/GuildContext';
import { PAGE_MAX_WIDTH } from '../theme';

/**
 * Server-wide settings that belong to no single feature. Today: staff roles.
 *
 * Staff roles are what a flow's `staff` audience compiles to when its journey is
 * installed, which is why this page unblocks installing a staff-gated flow from the
 * dashboard at all.
 *
 * A multi-select rather than the flow builder's `RolePickerControl`: that one is
 * single-select and coupled to the builder's declared-resource mechanism, neither of
 * which applies to a plain guild-wide list.
 */
export function ServerSettingsPage() {
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
                    › Configure › Server Settings
                </Text>
                <Title order={1} size="24px" mt={4}>
                    Server Settings
                </Title>
                <Text c="dimmed" size="13.5px" mt={4} maw={540}>
                    The server-wide stuff that isn&apos;t any one feature&apos;s business. Set it
                    once, and everything else stops asking.
                </Text>
            </div>

            <Card p="xl" maw={640}>
                <Group gap={8} mb={4}>
                    <IconUsersGroup size={18} color="var(--mantine-color-brand-6)" />
                    <Text fw={700} size="15px">
                        Staff Roles
                    </Text>
                </Group>
                <Text c="dimmed" size="13px" mb="lg">
                    Who counts as staff around here. When a flow builds a staff-only channel,
                    these are the roles that get the keys.
                </Text>

                {/* Keyed by server, so switching servers drops the draft and "last saved". */}
                <StaffRolesForm key={selected.id} guildId={selected.id} />
            </Card>

            <Card p="lg" maw={640} bg="dark.7">
                <Group gap={8} mb={6}>
                    <IconSettings size={18} color="var(--mantine-color-dark-2)" />
                    <Text fw={700} size="14px">
                        More settings, eventually
                    </Text>
                </Group>
                <Text size="13px" c="dimmed">
                    This page is where server-wide configuration lands as it gets built. Right now
                    staff roles are the whole show.
                </Text>
            </Card>
        </Stack>
    );
}

interface StaffRolesFormProps {
    readonly guildId: string;
}

/** The staff-role picker for one server: loads the saved list, edits it, saves it. */
function StaffRolesForm({ guildId }: StaffRolesFormProps) {
    const queryClient = useQueryClient();
    const settings = useQuery(getGuildSettingsOptions({ path: { guildId } }));
    const roles = useQuery(getGuildRolesOptions({ path: { guildId } }));

    // `undefined` until the operator edits: the picker shows what is saved.
    const [draftRoleIds, setDraftRoleIds] = useState<string[]>();
    const [lastSaved, setLastSaved] = useState<Date | null>(null);

    const save = useMutation({
        ...updateGuildSettingsMutation(),
        // A GET still in flight would land after the save and put the old list back.
        onMutate: ({ path }) => queryClient.cancelQueries({ queryKey: getGuildSettingsQueryKey({ path }) }),
        onSuccess: (updated, { path }) => {
            queryClient.setQueryData(getGuildSettingsQueryKey({ path }), updated);
            setDraftRoleIds(undefined);
            setLastSaved(new Date());
            notifications.show({
                color: 'brand',
                title: 'Saved',
                message: updated.staffRoleIds.length
                    ? `${updated.staffRoleIds.length} role${updated.staffRoleIds.length === 1 ? '' : 's'} now count as staff.`
                    : 'Nobody counts as staff right now. Bold strategy.',
            });
        },
        onError: (err) => {
            const message =
                err instanceof ApiError ? err.message : "Couldn't save. Try again in a second.";
            notifications.show({ color: 'red', title: "Couldn't save", message });
        },
    });

    const savedIds = useMemo(() => settings.data?.staffRoleIds ?? [], [settings.data]);
    const staffRoleIds = draftRoleIds ?? savedIds;

    /*
     * Options come from the guild's live roles, plus any saved id that no longer
     * resolves to one. Without that second half a deleted role vanishes from the
     * control while staying in the saved list, so the form would silently drop it on
     * the next save and the operator would never see what changed.
     */
    const roleOptions = useMemo(() => {
        const guildRoles = roles.data?.roles ?? [];
        const known = guildRoles.map((role) => ({ value: role.id, label: role.name }));
        const knownIds = new Set(guildRoles.map((role) => role.id));
        const orphaned = staffRoleIds
            .filter((roleId) => !knownIds.has(roleId))
            .map((roleId) => ({ value: roleId, label: `Deleted role (${roleId})` }));
        return [...known, ...orphaned];
    }, [roles.data, staffRoleIds]);

    // Compared as sets in both directions. A one-way membership check plus a length
    // test reads a real edit as pristine whenever the saved list holds a duplicate,
    // silently greying out Save with no way to tell why.
    const draftSet = new Set(staffRoleIds);
    const savedSet = new Set(savedIds);
    const pristine =
        draftSet.size === savedSet.size && [...draftSet].every((roleId) => savedSet.has(roleId));
    const saving = save.isPending;
    // An empty list is a legal save: it is how an operator says "nobody is staff yet".
    const canSave = !pristine && !saving;

    function handleSave() {
        save.mutate({ path: { guildId }, body: { staffRoleIds } });
    }

    function handleCancel() {
        setDraftRoleIds(undefined);
    }

    /*
     * An error wins over the spinner, so one refused load is shown at once rather than
     * after the other settles — but only while something is still missing. A failed
     * background refetch keeps the form, and the operator's draft, on screen.
     */
    const loaded = !!settings.data && !!roles.data;
    const loadError = settings.error ?? roles.error;
    if (loadError && !loaded) {
        return (
            <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Couldn't load settings">
                {loadError instanceof ApiError ? loadError.message : 'Failed to load server settings'}
            </Alert>
        );
    }

    if (!loaded) {
        return (
            <Center py="xl">
                <Loader color="brand" size="sm" />
            </Center>
        );
    }

    return (
        <Stack gap="lg">
            <MultiSelect
                label="Staff roles"
                description="Separate from your moderation roles — staff and mods aren't the same crowd here."
                placeholder={staffRoleIds.length ? undefined : 'Pick one or more roles'}
                data={roleOptions}
                value={staffRoleIds}
                onChange={setDraftRoleIds}
                searchable
                clearable
                nothingFoundMessage="No roles found"
                disabled={saving}
            />

            <Group gap="sm" mt="xs">
                <Button color="brand" onClick={handleSave} loading={saving} disabled={!canSave}>
                    Save changes
                </Button>
                <Button
                    variant="subtle"
                    color="gray"
                    onClick={handleCancel}
                    disabled={pristine || saving}
                >
                    Cancel
                </Button>
                {lastSaved && (
                    <Text size="12px" c="dark.2" ml="auto">
                        Last saved {lastSaved.toLocaleTimeString()}
                    </Text>
                )}
            </Group>
        </Stack>
    );
}
