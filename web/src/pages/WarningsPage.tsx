import { useEffect, useMemo, useState } from 'react';
import {
    Alert,
    Button,
    Card,
    Center,
    Group,
    Loader,
    Select,
    Stack,
    Text,
    Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconShieldHalf, IconBolt } from '@tabler/icons-react';
import { ApiError } from '../api/client';
import { getGuildChannels, getWarningsConfig, updateWarningsConfig } from '../api/config';
import type { GuildChannel, WarningsConfig } from '../api/types';
import { useGuilds } from '../guilds/GuildContext';

/**
 * Editable warnings config for the selected guild (Phase 2). Loads the current
 * mod-log channel + the guild's text channels, then PUTs changes through the
 * shared server config path. Matches the guild-dashboard mockup.
 */
export function WarningsPage() {
    const { selected, loading: guildsLoading } = useGuilds();

    const [config, setConfig] = useState<WarningsConfig | null>(null);
    const [channels, setChannels] = useState<GuildChannel[]>([]);
    const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
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
                const [cfg, chans] = await Promise.all([
                    getWarningsConfig(selected.id),
                    getGuildChannels(selected.id),
                ]);
                if (cancelled) return;
                setConfig(cfg);
                setChannels(chans);
                setSelectedChannelId(cfg.modChannelId);
                setLastSaved(null);
            } catch (err) {
                const message =
                    err instanceof ApiError ? err.message : 'Failed to load warnings config';
                if (!cancelled) setError(message);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [selected]);

    const channelOptions = useMemo(
        () => channels.map((ch) => ({ value: ch.id, label: `# ${ch.name}` })),
        [channels]
    );

    const pristine = selectedChannelId === (config?.modChannelId ?? null);
    const canSave = !pristine && !saving && !!selectedChannelId;

    async function handleSave() {
        if (!selected || !selectedChannelId) return;
        setSaving(true);
        try {
            const updated = await updateWarningsConfig(selected.id, selectedChannelId);
            setConfig(updated);
            setSelectedChannelId(updated.modChannelId);
            setLastSaved(new Date());
            notifications.show({
                color: 'brand',
                title: 'Saved',
                message: `Warning notices now land in # ${updated.modChannelName ?? 'your channel'}.`,
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
        setSelectedChannelId(config?.modChannelId ?? null);
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
        <Stack gap="lg" maw={1100}>
            <div>
                <Text size="12.5px" c="dark.2">
                    <Text span c="dark.1" fw={600}>
                        {selected.name}
                    </Text>{' '}
                    › Configure › Warnings
                </Text>
                <Title order={1} size="24px" mt={4}>
                    Warnings
                </Title>
                <Text c="dimmed" size="13.5px" mt={4} maw={540}>
                    Keep the troublemakers in line. Configure where infractions get logged and how the
                    bot handles repeat offenders.
                </Text>
            </div>

            <Group align="flex-start" gap="lg" wrap="wrap">
                <Card p="xl" flex="1" miw={340}>
                    <Group gap={8} mb={4}>
                        <IconShieldHalf size={18} color="var(--mantine-color-brand-6)" />
                        <Text fw={700} size="15px">
                            Warning Settings
                        </Text>
                    </Group>
                    <Text c="dimmed" size="13px" mb="lg">
                        Warnings let your mods flag misbehavior. Every strike gets receipts in your log
                        channel — no more &quot;he said / she said.&quot;
                    </Text>

                    {loading ? (
                        <Center py="xl">
                            <Loader color="brand" size="sm" />
                        </Center>
                    ) : error ? (
                        <Alert
                            color="red"
                            icon={<IconAlertTriangle size={16} />}
                            title="Couldn't load config"
                        >
                            {error}
                        </Alert>
                    ) : (
                        <Stack gap="lg">
                            <Select
                                label="Mod Log Channel"
                                description="All warnings, mutes and bans get posted here. Keep it staff-only, obviously."
                                placeholder="Pick a channel"
                                data={channelOptions}
                                value={selectedChannelId}
                                onChange={setSelectedChannelId}
                                searchable
                                nothingFoundMessage="No text channels found"
                                allowDeselect={false}
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

                <Card
                    p="lg"
                    w={320}
                    style={{
                        background:
                            'linear-gradient(145deg, rgba(0,162,255,0.16), rgba(0,162,255,0.05))',
                        borderColor: 'rgba(0,162,255,0.4)',
                    }}
                >
                    <Group gap={8} mb={6}>
                        <IconBolt size={18} color="var(--mantine-color-brand-4)" />
                        <Text fw={800} size="17px">
                            Meet Flows
                        </Text>
                    </Group>
                    <Text size="13px" c="dimmed">
                        Build onboarding, reaction roles &amp; more — no code. Drag, drop, done. Coming
                        soon.
                    </Text>
                </Card>
            </Group>
        </Stack>
    );
}
