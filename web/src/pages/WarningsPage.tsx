import { useMemo, useState } from 'react';
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    ApiError,
    getGuildChannelsOptions,
    getWarningsConfigOptions,
    getWarningsConfigQueryKey,
    updateWarningsConfigMutation,
    zUpdateWarningsConfigBody,
} from '@brattybot/web-sdk';
import { channelOptionLabel, postableChannels } from '../flows/resourceAdoption';
import { useGuilds } from '../guilds/GuildContext';
import { PAGE_MAX_WIDTH } from '../theme';

/**
 * Editable warnings config for the selected guild (Phase 2). Loads the current
 * mod-log channel + the guild's text channels, then PUTs changes through the
 * shared server config path. Matches the guild-dashboard mockup.
 */
export function WarningsPage() {
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

                    {/* Keyed by server, so switching servers drops the draft and "last saved". */}
                    <WarningsSettingsForm key={selected.id} guildId={selected.id} />
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

interface WarningsSettingsFormProps {
    readonly guildId: string;
}

/** The mod-log channel picker for one server: loads its config, edits it, saves it. */
function WarningsSettingsForm({ guildId }: WarningsSettingsFormProps) {
    const queryClient = useQueryClient();
    const config = useQuery(getWarningsConfigOptions({ path: { guildId } }));
    const channels = useQuery(getGuildChannelsOptions({ path: { guildId } }));

    // `undefined` until the operator picks something: the picker shows what is saved.
    const [draftChannelId, setDraftChannelId] = useState<string | null>();
    const [lastSaved, setLastSaved] = useState<Date | null>(null);

    const save = useMutation({
        ...updateWarningsConfigMutation(),
        // A GET still in flight would land after the save and put the old value back.
        onMutate: ({ path }) => queryClient.cancelQueries({ queryKey: getWarningsConfigQueryKey({ path }) }),
        onSuccess: (updated, { path }) => {
            queryClient.setQueryData(getWarningsConfigQueryKey({ path }), updated);
            setDraftChannelId(undefined);
            setLastSaved(new Date());
            notifications.show({
                color: 'brand',
                title: 'Saved',
                message: `Warning notices now land in # ${updated.modChannelName ?? 'your channel'}.`,
            });
        },
        onError: (err) => {
            const message =
                err instanceof ApiError ? err.message : "Couldn't save. Try again in a second.";
            notifications.show({ color: 'red', title: "Couldn't save", message });
        },
    });

    /*
     * Postable channels only. The directory now carries categories so they can be
     * adopted in the flow builder, and a mod-log notice posted to a category id fails
     * at send time — the same filter every other channel picker applies, through the
     * same predicate so they cannot drift apart.
     */
    const channelOptions = useMemo(
        () =>
            postableChannels(channels.data?.channels ?? []).map((ch) => ({
                value: ch.id,
                label: channelOptionLabel(ch),
            })),
        [channels.data]
    );

    const savedChannelId = config.data?.modChannelId ?? null;
    const selectedChannelId = draftChannelId === undefined ? savedChannelId : draftChannelId;
    const saving = save.isPending;
    const pristine = selectedChannelId === savedChannelId;

    /*
     * Whether the body is sendable is the server's rule, asked of the zod the SDK
     * generates from its route rather than restated here. The rule's sentence crosses
     * with it, but this picker has no empty state to show it under — Save is simply
     * disabled — and a refusal on save arrives in the server's own words as the error.
     */
    const body = zUpdateWarningsConfigBody.safeParse({ modChannelId: selectedChannelId });
    const canSave = !pristine && !saving && body.success;

    function handleSave() {
        if (!body.success) return;
        save.mutate({ path: { guildId }, body: body.data });
    }

    function handleCancel() {
        setDraftChannelId(undefined);
    }

    /*
     * An error wins over the spinner, so one refused load is shown at once rather than
     * after the other settles — but only while something is still missing. A failed
     * background refetch keeps the form, and the operator's draft, on screen.
     */
    const loaded = !!config.data && !!channels.data;
    const loadError = config.error ?? channels.error;
    if (loadError && !loaded) {
        return (
            <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Couldn't load config">
                {loadError instanceof ApiError ? loadError.message : 'Failed to load warnings config'}
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
            <Select
                label="Mod Log Channel"
                description="All warnings, mutes and bans get posted here. Keep it staff-only, obviously."
                placeholder="Pick a channel"
                data={channelOptions}
                value={selectedChannelId}
                onChange={setDraftChannelId}
                searchable
                nothingFoundMessage="No text channels found"
                allowDeselect={false}
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
