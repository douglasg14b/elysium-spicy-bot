import { useMemo, useState } from 'react';
import {
    Alert,
    Badge,
    Button,
    Card,
    Center,
    Group,
    Loader,
    Modal,
    Stack,
    Table,
    Text,
    Title,
    Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconFlame, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    ApiError,
    deleteFlashChatChannelMutation,
    getGuildChannelsOptions,
    listFlashChatChannelsOptions,
    listFlashChatChannelsQueryKey,
    saveFlashChatChannelMutation,
    type FlashChatChannel,
    type FlashChatSettings,
    type ListFlashChatChannelsResponse,
} from '@brattybot/web-sdk';
import { loadErrorMessage } from '../api/loadErrorMessage';
import { useSaveInFlight } from '../api/useSaveInFlight';
import { writeSavedAnswer } from '../api/writeSavedAnswer';
import { FlashChatChannelModal, type FlashChatModalTarget } from '../flash-chat/FlashChatChannelModal';
import { describeTimer } from '../flash-chat/flashChatTimer';
import { channelOptionLabel, postableChannels } from '../flows/resourceAdoption';
import { useGuilds } from '../guilds/GuildContext';
import { PAGE_MAX_WIDTH } from '../theme';

/**
 * Flash chat for the selected server: the channels whose messages delete themselves, and
 * after how long. Every change goes through the same service as `/flash-chat`, so it takes
 * effect at once and the channel is told when the slash command would tell it.
 */
export function FlashChatPage() {
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
                    › Configure › Flash Chat
                </Text>
                <Title order={1} size="24px" mt={4}>
                    Flash Chat
                </Title>
                <Text c="dimmed" size="13.5px" mt={4} maw={560}>
                    Burn after reading. Pick a channel and a timer, and every message posted there
                    self-destructs when it runs out — confessions, nudes, and bad decisions included.
                </Text>
            </div>

            {/* Keyed by server, so switching servers closes any open dialog. */}
            <FlashChatChannels key={selected.id} guildId={selected.id} />
        </Stack>
    );
}

interface FlashChatChannelsProps {
    readonly guildId: string;
}

/** One server's flash chat channels: the list, and the dialogs that add, change and remove them. */
function FlashChatChannels({ guildId }: FlashChatChannelsProps) {
    const queryClient = useQueryClient();
    const list = useQuery(listFlashChatChannelsOptions({ path: { guildId } }));
    const channels = useQuery(getGuildChannelsOptions({ path: { guildId } }));
    const listKey = listFlashChatChannelsQueryKey({ path: { guildId } });

    const [editing, setEditing] = useState<FlashChatModalTarget | null>(null);
    const [pendingRemoval, setPendingRemoval] = useState<FlashChatChannel | null>(null);

    // Saves and removals both carry the list's key, so a remounted page sees either in flight.
    const writing = useSaveInFlight(listKey);

    const save = useMutation({
        ...saveFlashChatChannelMutation(),
        mutationKey: listKey,
        onSuccess: async (saved) => {
            const isNew = !queryClient
                .getQueryData<ListFlashChatChannelsResponse>(listKey)
                ?.channels.some((channel) => channel.channelId === saved.channelId);
            await writeSavedAnswer<ListFlashChatChannelsResponse>(queryClient, listKey, (current) => ({
                channels: isNew
                    ? [...(current?.channels ?? []), saved]
                    : (current?.channels ?? []).map((channel) => (channel.channelId === saved.channelId ? saved : channel)),
            }));
            setEditing(null);
            if (!saved.running) {
                notifications.show({
                    color: 'yellow',
                    title: 'Saved, but not running',
                    message: `I couldn't start deleting in #${saved.channelName ?? 'that channel'}. Check I can still see it and manage messages there, then save again.`,
                });
                return;
            }
            notifications.show({
                color: 'brand',
                title: isNew ? 'Flash chat is on' : 'Saved',
                message: isNew
                    ? `Messages in #${saved.channelName ?? 'that channel'} now self-destruct after ${describeTimer(saved.timeoutSeconds)}.`
                    : `#${saved.channelName ?? 'That channel'} now keeps messages for ${describeTimer(saved.timeoutSeconds)}.`,
            });
        },
        onError: (err) => {
            showRefusal("Couldn't save", err);
            // A refusal can mean the list on screen is out of date (another tab, the slash command).
            void queryClient.invalidateQueries({ queryKey: listKey });
        },
    });

    const remove = useMutation({
        ...deleteFlashChatChannelMutation(),
        mutationKey: listKey,
        onSuccess: async (_answer, variables) => {
            const { channelId } = variables.path;
            await writeSavedAnswer<ListFlashChatChannelsResponse>(queryClient, listKey, (current) => ({
                channels: (current?.channels ?? []).filter((channel) => channel.channelId !== channelId),
            }));
            setPendingRemoval(null);
            notifications.show({
                color: 'brand',
                title: 'Flash chat is off',
                message: 'Messages there live forever again. Choose your words accordingly.',
            });
        },
        onError: (err) => {
            showRefusal("Couldn't turn it off", err);
            // Closed either way: a refusal (already off, from another tab) leaves nothing to confirm.
            setPendingRemoval(null);
            void queryClient.invalidateQueries({ queryKey: listKey });
        },
    });

    const configuredIds = useMemo(
        () => new Set((list.data?.channels ?? []).map((channel) => channel.channelId)),
        [list.data]
    );
    const channelOptions = useMemo(
        () =>
            postableChannels(channels.data?.channels ?? [])
                .filter((channel) => !configuredIds.has(channel.id))
                .map((channel) => ({ value: channel.id, label: channelOptionLabel(channel) })),
        [channels.data, configuredIds]
    );

    function handleSave(channelId: string, settings: FlashChatSettings) {
        save.mutate({ path: { guildId, channelId }, body: settings });
    }

    function handleRemove() {
        if (!pendingRemoval) return;
        remove.mutate({ path: { guildId, channelId: pendingRemoval.channelId } });
    }

    /*
     * An error wins over the spinner only while something is still missing; a failed
     * background refetch keeps the list on screen.
     */
    const loaded = !!list.data && !!channels.data;
    const loadError = list.error ?? channels.error;
    if (loadError && !loaded) {
        return (
            <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Couldn't load flash chat">
                {loadErrorMessage(loadError, 'Failed to load flash chat settings')}
            </Alert>
        );
    }

    if (!list.data || !channels.data) {
        return (
            <Center py="xl">
                <Loader color="brand" size="sm" />
            </Center>
        );
    }

    return (
        <>
            <Card p={0} style={{ overflow: 'hidden' }}>
                <Group justify="space-between" align="flex-end" p="md" wrap="wrap">
                    <div>
                        <Group gap={8}>
                            <IconFlame size={18} color="var(--mantine-color-brand-6)" />
                            <Text fw={700} size="15px">
                                Self-destructing channels
                            </Text>
                        </Group>
                        <Text c="dimmed" size="13px" mt={2} maw={560}>
                            The channel hears about it when flash chat starts, stops, or its timer changes.
                        </Text>
                    </div>
                    <Button
                        color="brand"
                        leftSection={<IconPlus size={16} />}
                        onClick={() => setEditing({ kind: 'new' })}
                    >
                        Add channel
                    </Button>
                </Group>

                {list.data.channels.length === 0 ? (
                    <Stack align="center" gap={6} py={40} px="md">
                        <IconFlame size={28} color="var(--mantine-color-dark-3)" />
                        <Text fw={700} size="15px">
                            Nothing burns yet
                        </Text>
                        <Text c="dimmed" size="13px" ta="center" maw={420}>
                            Every message in this server sticks around forever. Add a channel to change that.
                        </Text>
                    </Stack>
                ) : (
                    <Table.ScrollContainer minWidth={640}>
                        <Table layout="fixed" verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>Channel</Table.Th>
                                    <Table.Th w={190}>Deletes after</Table.Th>
                                    <Table.Th w={110}>Pinned</Table.Th>
                                    <Table.Th w={110} />
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {list.data.channels.map((channel) => (
                                    <FlashChatRow
                                        key={channel.channelId}
                                        channel={channel}
                                        onEdit={() => setEditing({ kind: 'existing', channel })}
                                        onRemove={() => setPendingRemoval(channel)}
                                    />
                                ))}
                            </Table.Tbody>
                        </Table>
                    </Table.ScrollContainer>
                )}
            </Card>

            {editing && (
                <FlashChatChannelModal
                    target={editing}
                    channelOptions={channelOptions}
                    saving={writing}
                    onSave={handleSave}
                    onClose={() => setEditing(null)}
                />
            )}

            <Modal
                opened={pendingRemoval !== null}
                onClose={() => setPendingRemoval(null)}
                title="Turn off flash chat"
                size="md"
            >
                <Stack gap="md">
                    <Text size="13.5px" c="dimmed">
                        Messages in{' '}
                        <Text span fw={700} c="bright">
                            #{pendingRemoval?.channelName ?? 'deleted-channel'}
                        </Text>{' '}
                        stop self-destructing, and its settings are forgotten. Anything already deleted stays
                        deleted.
                    </Text>
                    <Group justify="flex-end" gap="sm">
                        <Button variant="subtle" color="gray" onClick={() => setPendingRemoval(null)} disabled={writing}>
                            Cancel
                        </Button>
                        <Button color="red" loading={writing} onClick={handleRemove}>
                            Turn off
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </>
    );
}

interface FlashChatRowProps {
    readonly channel: FlashChatChannel;
    readonly onEdit: () => void;
    readonly onRemove: () => void;
}

function FlashChatRow({ channel, onEdit, onRemove }: FlashChatRowProps) {
    const gone = channel.channelName === null;
    const label = gone ? 'deleted channel' : `#${channel.channelName}`;

    return (
        <Table.Tr>
            <Table.Td>
                <Group gap={8} wrap="nowrap">
                    <Text fw={600} size="13.5px" truncate c={gone ? 'dimmed' : undefined}>
                        {label}
                    </Text>
                    {/* Only on a row that is broken, so the chip says something when it shows. */}
                    {gone ? (
                        <Tooltip label="Discord no longer has this channel. Turn flash chat off to tidy it away.">
                            <Badge variant="light" color="gray" radius="sm">
                                Channel gone
                            </Badge>
                        </Tooltip>
                    ) : (
                        !channel.running && (
                            <Tooltip
                                label="I couldn't start deleting here. Check I can still see the channel and manage messages in it, then save it again."
                                multiline
                                w={280}
                            >
                                <Badge variant="light" color="red" radius="sm">
                                    Not running
                                </Badge>
                            </Tooltip>
                        )
                    )}
                </Group>
                <Text size="12px" c="dark.2">
                    {channel.preserveHistory ? 'Older messages kept' : 'Older messages wiped'} · last saved by{' '}
                    {channel.updatedByName}
                </Text>
            </Table.Td>
            <Table.Td>
                <Text size="13px">{describeTimer(channel.timeoutSeconds)}</Text>
            </Table.Td>
            <Table.Td>
                <Text size="12px" c="dark.1">
                    {channel.preservePinned ? 'Kept' : 'Deleted too'}
                </Text>
            </Table.Td>
            <Table.Td>
                <Group gap={6} justify="flex-end" wrap="nowrap">
                    {!gone && (
                        <Tooltip label="Edit">
                            <Button
                                size="xs"
                                variant="subtle"
                                color="gray"
                                px={8}
                                onClick={onEdit}
                                aria-label={`Edit flash chat in ${label}`}
                            >
                                <IconPencil size={14} />
                            </Button>
                        </Tooltip>
                    )}
                    <Tooltip label="Turn off">
                        <Button
                            size="xs"
                            variant="subtle"
                            color="red"
                            px={8}
                            onClick={onRemove}
                            aria-label={`Turn off flash chat in ${label}`}
                        >
                            <IconTrash size={14} />
                        </Button>
                    </Tooltip>
                </Group>
            </Table.Td>
        </Table.Tr>
    );
}

function showRefusal(title: string, err: unknown): void {
    const message = err instanceof ApiError ? err.message : 'Something went sideways. Try again in a second.';
    notifications.show({ color: 'red', title, message });
}
