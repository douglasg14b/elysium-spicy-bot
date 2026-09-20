import { useEffect, useMemo, useState } from 'react';
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
import { ApiError } from '../api/client';
import { getGuildSettings, updateGuildSettings } from '../api/config';
import { getGuildRoles } from '../api/flows';
import type { GuildRole, GuildSettings } from '../api/types';
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

    const [settings, setSettings] = useState<GuildSettings | null>(null);
    const [roles, setRoles] = useState<GuildRole[]>([]);
    const [staffRoleIds, setStaffRoleIds] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [lastSaved, setLastSaved] = useState<Date | null>(null);

    useEffect(() => {
        if (!selected) return;
        let cancelled = false;
        void (async () => {
            setLoading(true);
            setError(null);
            try {
                const [saved, guildRoles] = await Promise.all([
                    getGuildSettings(selected.id),
                    getGuildRoles(selected.id),
                ]);
                if (cancelled) return;
                setSettings(saved);
                setRoles(guildRoles);
                setStaffRoleIds(saved.staffRoleIds);
                setLastSaved(null);
            } catch (err) {
                const message =
                    err instanceof ApiError ? err.message : 'Failed to load server settings';
                if (!cancelled) setError(message);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [selected]);

    /*
     * Options come from the guild's live roles, plus any saved id that no longer
     * resolves to one. Without that second half a deleted role vanishes from the
     * control while staying in the saved list, so the form would silently drop it on
     * the next save and the operator would never see what changed.
     */
    const roleOptions = useMemo(() => {
        const known = roles.map((role) => ({ value: role.id, label: role.name }));
        const knownIds = new Set(roles.map((role) => role.id));
        const orphaned = staffRoleIds
            .filter((roleId) => !knownIds.has(roleId))
            .map((roleId) => ({ value: roleId, label: `Deleted role (${roleId})` }));
        return [...known, ...orphaned];
    }, [roles, staffRoleIds]);

    // Compared as sets in both directions. A one-way membership check plus a length
    // test reads a real edit as pristine whenever the saved list holds a duplicate,
    // silently greying out Save with no way to tell why.
    const savedIds = settings?.staffRoleIds ?? [];
    const draftSet = new Set(staffRoleIds);
    const savedSet = new Set(savedIds);
    const pristine =
        draftSet.size === savedSet.size && [...draftSet].every((roleId) => savedSet.has(roleId));
    // An empty list is a legal save: it is how an operator says "nobody is staff yet".
    const canSave = !pristine && !saving;

    async function handleSave() {
        if (!selected) return;
        setSaving(true);
        try {
            const updated = await updateGuildSettings(selected.id, staffRoleIds);
            setSettings(updated);
            setStaffRoleIds(updated.staffRoleIds);
            setLastSaved(new Date());
            notifications.show({
                color: 'brand',
                title: 'Saved',
                message: updated.staffRoleIds.length
                    ? `${updated.staffRoleIds.length} role${updated.staffRoleIds.length === 1 ? '' : 's'} now count as staff.`
                    : 'Nobody counts as staff right now. Bold strategy.',
            });
        } catch (err) {
            const message =
                err instanceof ApiError ? err.message : "Couldn't save. Try again in a second.";
            notifications.show({ color: 'red', title: "Couldn't save", message });
        } finally {
            setSaving(false);
        }
    }

    function handleCancel() {
        setStaffRoleIds(settings?.staffRoleIds ?? []);
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

                {loading ? (
                    <Center py="xl">
                        <Loader color="brand" size="sm" />
                    </Center>
                ) : error ? (
                    <Alert
                        color="red"
                        icon={<IconAlertTriangle size={16} />}
                        title="Couldn't load settings"
                    >
                        {error}
                    </Alert>
                ) : (
                    <Stack gap="lg">
                        <MultiSelect
                            label="Staff roles"
                            description="Separate from your moderation roles — staff and mods aren't the same crowd here."
                            placeholder={staffRoleIds.length ? undefined : 'Pick one or more roles'}
                            data={roleOptions}
                            value={staffRoleIds}
                            onChange={setStaffRoleIds}
                            searchable
                            clearable
                            nothingFoundMessage="No roles found"
                            disabled={saving}
                        />

                        <Group gap="sm" mt="xs">
                            <Button
                                color="brand"
                                onClick={handleSave}
                                loading={saving}
                                disabled={!canSave}
                            >
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
                )}
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
