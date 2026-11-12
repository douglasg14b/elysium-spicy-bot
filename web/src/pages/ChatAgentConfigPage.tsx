import { useMemo, useState, type ReactNode } from 'react';
import {
    ActionIcon,
    Alert,
    Button,
    Card,
    Center,
    Checkbox,
    Group,
    Loader,
    MultiSelect,
    Select,
    Stack,
    Text,
    Textarea,
    Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconGavel, IconHandStop, IconMessageChatbot, IconNotes, IconUserCircle, IconX } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    ApiError,
    getChatAgentConfigOptions,
    getChatAgentConfigQueryKey,
    getGuildChannelsOptions,
    getGuildRolesOptions,
    updateChatAgentConfigMutation,
    zUpdateChatAgentConfigBody,
    type ChatAgentConfigUpdate,
} from '@brattybot/web-sdk';
import { useSaveInFlight } from '../api/useSaveInFlight';
import { writeSavedAnswer } from '../api/writeSavedAnswer';
import { channelOptionLabel, postableChannels } from '../flows/resourceAdoption';
import { useGuilds } from '../guilds/GuildContext';
import { PAGE_MAX_WIDTH } from '../theme';

type ContextChannelDraft = ChatAgentConfigUpdate['contextChannels'][number];

/** The admins' two texts; both go into the bot's instructions on every reply. */
const GUIDANCE_KEYS = ['botRules', 'serverNotes'] as const;
type GuidanceKey = (typeof GUIDANCE_KEYS)[number];

/** The texts' limit, as the server's schema states it. */
const GUIDANCE_LIMIT: Record<GuidanceKey, number | null> = {
    botRules: zUpdateChatAgentConfigBody.shape.botRules.maxLength,
    serverNotes: zUpdateChatAgentConfigBody.shape.serverNotes.maxLength,
};

/**
 * The chat agent's config for the selected guild: the channels it reads when someone @s it,
 * each optionally marked as a rules channel, its intros channel, who counts as staff to it, and
 * the admins' rules for it and notes about the server. Laid out as `WarningsConfigPage`.
 */
export function ChatAgentConfigPage() {
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
                    › Configure › Chat agent
                </Text>
                <Group gap={10} mt={4}>
                    <IconMessageChatbot size={22} color="var(--mantine-color-brand-6)" />
                    <Title order={1} size="24px">
                        Chat agent
                    </Title>
                </Group>
                <Text c="dimmed" size="13.5px" mt={4} maw={540}>
                    What the bot knows and how it behaves when someone @s it: the channels it reads, who it
                    treats as staff, your rules for it, and notes about the server it can pass on.
                </Text>
            </div>

            {/* Keyed by server, so switching servers drops the draft and "last saved". */}
            <ChatAgentConfigForm key={selected.id} guildId={selected.id} />
        </Stack>
    );
}

interface ChatAgentConfigFormProps {
    readonly guildId: string;
}

/** The chat agent config for one server: loads it, edits it, saves it whole. */
function ChatAgentConfigForm({ guildId }: ChatAgentConfigFormProps) {
    const queryClient = useQueryClient();
    const config = useQuery(getChatAgentConfigOptions({ path: { guildId } }));
    const channels = useQuery(getGuildChannelsOptions({ path: { guildId } }));
    const roles = useQuery(getGuildRolesOptions({ path: { guildId } }));
    const configKey = getChatAgentConfigQueryKey({ path: { guildId } });

    // Only the fields the operator changed: the rest follow what is saved, so a refetch (another tab's save) is not undone.
    const [draft, setDraft] = useState<Partial<ChatAgentConfigUpdate>>();
    const [lastSaved, setLastSaved] = useState<Date | null>(null);

    const save = useMutation({
        ...updateChatAgentConfigMutation(),
        // Keyed by the entry it writes, so this form remounted mid-save still sees it.
        mutationKey: configKey,
        onSuccess: async (updated) => {
            // Over any GET still in flight, which would otherwise put the old list back.
            await writeSavedAnswer(queryClient, configKey, updated);
            setDraft(undefined);
            setLastSaved(new Date());
            notifications.show({ color: 'brand', title: 'Saved', message: 'Chat agent config saved.' });
        },
        onError: (err) => {
            const message = err instanceof ApiError ? err.message : "Couldn't save. Try again in a second.";
            notifications.show({ color: 'red', title: "Couldn't save", message });
        },
    });

    const saved = useMemo<ChatAgentConfigUpdate>(
        () => ({
            contextChannels: (config.data?.contextChannels ?? []).map(({ channelId, isRules }) => ({ channelId, isRules })),
            botRules: config.data?.botRules ?? '',
            serverNotes: config.data?.serverNotes ?? '',
            staffRoleIds: config.data?.staffRoleIds ?? [],
            introsChannelId: config.data?.introsChannelId ?? null,
        }),
        [config.data]
    );
    const current: ChatAgentConfigUpdate = { ...saved, ...draft };
    const list = current.contextChannels;
    // What a save sends: the texts trimmed, as the server stores them, so the count, "changed" and the check all judge it.
    const sent: ChatAgentConfigUpdate = { ...current, botRules: current.botRules.trim(), serverNotes: current.serverNotes.trim() };

    // Postable channels only, the filter every channel picker applies.
    const textChannels = useMemo(() => postableChannels(channels.data?.channels ?? []), [channels.data]);
    const addOptions = textChannels
        .filter((channel) => !list.some((entry) => entry.channelId === channel.id))
        .map((channel) => ({ value: channel.id, label: channelOptionLabel(channel) }));

    // The intros channel picker: postable text channels, plus the saved one once it is gone, so the control still shows what is stored.
    const introsOptions = textChannels.map((channel) => ({ value: channel.id, label: channelOptionLabel(channel) }));
    if (current.introsChannelId && !textChannels.some((channel) => channel.id === current.introsChannelId)) {
        const savedName = config.data?.introsChannelName;
        introsOptions.push({ value: current.introsChannelId, label: savedName ? `#${savedName}` : 'Deleted channel' });
    }

    /*
     * The staff role picker: the guild's live roles, plus any saved id that no longer resolves
     * to one — as Server Settings does, so a deleted role stays visible rather than being
     * dropped unseen by the next save.
     */
    const roleOptions = useMemo(() => {
        const guildRoles = roles.data?.roles ?? [];
        const knownIds = new Set(guildRoles.map((role) => role.id));
        const orphaned = current.staffRoleIds
            .filter((roleId) => !knownIds.has(roleId))
            .map((roleId) => ({ value: roleId, label: `Deleted role (${roleId})` }));
        return [...guildRoles.map((role) => ({ value: role.id, label: role.name })), ...orphaned];
    }, [roles.data, current.staffRoleIds]);

    /** A row's name: from the directory, else as last saved, else gone. */
    function channelName(channelId: string): string {
        const listed = textChannels.find((channel) => channel.id === channelId);
        if (listed) return channelOptionLabel(listed);
        const savedName = config.data?.contextChannels.find((entry) => entry.channelId === channelId)?.channelName;
        return savedName ? `#${savedName}` : 'Deleted channel';
    }

    const saving = useSaveInFlight(configKey);
    // Staff roles compared as sets, as Server Settings does: the server stores them once each.
    const savedStaff = new Set(saved.staffRoleIds);
    const draftStaff = new Set(current.staffRoleIds);
    const pristine =
        sent.botRules === saved.botRules &&
        sent.serverNotes === saved.serverNotes &&
        sent.introsChannelId === saved.introsChannelId &&
        draftStaff.size === savedStaff.size &&
        [...draftStaff].every((roleId) => savedStaff.has(roleId)) &&
        list.length === saved.contextChannels.length &&
        list.every(
            (entry, index) =>
                entry.channelId === saved.contextChannels[index].channelId && entry.isRules === saved.contextChannels[index].isRules
        );

    // The server's rules, through the zod the SDK generates from its route; its sentence is shown as is.
    const body = zUpdateChatAgentConfigBody.safeParse(sent);
    const canSave = !pristine && !saving && body.success;

    function setChannels(contextChannels: ContextChannelDraft[]) {
        setDraft({ ...draft, contextChannels });
    }

    function handleAdd(channelId: string | null) {
        if (!channelId) return;
        setChannels([...list, { channelId, isRules: false }]);
    }

    function handleRulesToggle(channelId: string, isRules: boolean) {
        setChannels(list.map((entry) => (entry.channelId === channelId ? { ...entry, isRules } : entry)));
    }

    function handleRemove(channelId: string) {
        setChannels(list.filter((entry) => entry.channelId !== channelId));
    }

    /** The schema's sentence for one text, once it is over its limit. */
    function guidanceProblem(key: GuidanceKey): string | undefined {
        return body.success ? undefined : body.error.issues.find((issue) => issue.path[0] === key)?.message;
    }

    /** `120 / 2,000` under a text, so the limit is seen before it is hit. */
    function guidanceCount(key: GuidanceKey): string {
        const limit = GUIDANCE_LIMIT[key];
        const length = sent[key].length.toLocaleString('en-US');
        return limit === null ? length : `${length} / ${limit.toLocaleString('en-US')}`;
    }

    function handleSave() {
        if (!body.success) return;
        save.mutate({ path: { guildId }, body: body.data });
    }

    // As on the warnings page: an error wins over the spinner only while something is still missing.
    const loaded = !!config.data && !!channels.data && !!roles.data;
    const loadError = config.error ?? channels.error ?? roles.error;
    if (loadError && !loaded) {
        return (
            <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Couldn't load config">
                {loadError instanceof ApiError ? loadError.message : 'Failed to load chat agent config'}
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

    // The texts' problems sit under their boxes; any other refusal (the channel list's) under the save.
    const otherProblem = body.success
        ? undefined
        : body.error.issues.find((issue) => !GUIDANCE_KEYS.some((key) => key === issue.path[0]))?.message;

    return (
        <Stack gap="lg">
            <Card p="xl" maw={640}>
                <SectionHeading icon={<IconMessageChatbot size={18} color="var(--mantine-color-brand-6)" />} title="Context channels" />
                <Text c="dimmed" size="13px" mb="md">
                    Channels it reads when someone @s it. Mark the ones holding your rules and it quotes those instead
                    of Discord&apos;s rules channel. It never shows anyone a channel they can&apos;t already see.
                </Text>
                <Stack gap="lg">
                    {list.length === 0 ? (
                        <Text c="dimmed" size="13px">
                            No context channels yet. Rules come from Discord&apos;s rules channel.
                        </Text>
                    ) : (
                        <Stack gap="xs">
                            {list.map((entry) => {
                                const name = channelName(entry.channelId);
                                return (
                                    <Group key={entry.channelId} justify="space-between" wrap="nowrap">
                                        <Text size="14px">{name}</Text>
                                        <Group gap="sm" wrap="nowrap">
                                            <Checkbox
                                                label="Rules channel"
                                                aria-label={`${name} is a rules channel`}
                                                checked={entry.isRules}
                                                onChange={(event) => handleRulesToggle(entry.channelId, event.currentTarget.checked)}
                                                disabled={saving}
                                            />
                                            <ActionIcon
                                                variant="subtle"
                                                color="gray"
                                                onClick={() => handleRemove(entry.channelId)}
                                                aria-label={`Remove ${name}`}
                                                disabled={saving}
                                            >
                                                <IconX size={16} />
                                            </ActionIcon>
                                        </Group>
                                    </Group>
                                );
                            })}
                        </Stack>
                    )}

                    <Select
                        label="Add a channel"
                        placeholder="Pick a channel"
                        data={addOptions}
                        value={null}
                        onChange={handleAdd}
                        searchable
                        nothingFoundMessage="No text channels found"
                        disabled={saving}
                    />
                </Stack>
            </Card>

            <Card p="xl" maw={640}>
                <SectionHeading icon={<IconUserCircle size={18} color="var(--mantine-color-brand-6)" />} title="Intros channel" />
                <Select
                    label="Where members introduce themselves"
                    description="It keeps a copy of everyone's intro, so it knows who it's talking to — and their pronouns, when they gave them. Only used where everyone reading can see this channel."
                    placeholder="No intros channel"
                    data={introsOptions}
                    value={current.introsChannelId}
                    onChange={(introsChannelId) => setDraft({ ...draft, introsChannelId })}
                    searchable
                    clearable
                    nothingFoundMessage="No text channels found"
                    disabled={saving}
                />
            </Card>

            <Card p="xl" maw={640}>
                <SectionHeading icon={<IconHandStop size={18} color="var(--mantine-color-brand-6)" />} title="Staff, as far as the bot cares" />
                <MultiSelect
                    label="Staff roles"
                    description="Who it answers staff-only questions for — tickets, other channels' messages, who can see what, levels and XP — and only where everyone reading is one of them. Separate from Server Settings, so your mods can count here without getting the keys to the dashboard. The owner and Administrators always count. Leave it empty and it uses Server Settings' staff roles."
                    placeholder={current.staffRoleIds.length ? undefined : "Server Settings' staff roles"}
                    data={roleOptions}
                    value={[...current.staffRoleIds]}
                    onChange={(staffRoleIds) => setDraft({ ...draft, staffRoleIds })}
                    searchable
                    clearable
                    nothingFoundMessage="No roles found"
                    disabled={saving}
                />
            </Card>

            <Card p="xl" maw={640}>
                <SectionHeading icon={<IconGavel size={18} color="var(--mantine-color-brand-6)" />} title="Bot rules" />
                <Textarea
                    label="Rules for the bot"
                    description={`How it should behave here. It follows these on every reply, but they can't talk it past its own lines — and anyone can coax them out of it, so nothing secret. ${guidanceCount('botRules')}`}
                    placeholder={'Never recommend other servers.\nPoint newcomers at #introductions before anything else.'}
                    autosize
                    minRows={3}
                    maxRows={12}
                    value={current.botRules}
                    onChange={(event) => setDraft({ ...draft, botRules: event.currentTarget.value })}
                    error={guidanceProblem('botRules')}
                    disabled={saving}
                />
            </Card>

            <Card p="xl" maw={640}>
                <SectionHeading icon={<IconNotes size={18} color="var(--mantine-color-brand-6)" />} title="Server notes" />
                <Textarea
                    label="Notes about the server"
                    description={`Facts it can hand out — events, how things work, who to ask. It may repeat any of this to anyone, so nothing mod-only. ${guidanceCount('serverNotes')}`}
                    placeholder={'Munches are the first Saturday of the month.\nAsk @Mara about the Discord stage nights.'}
                    autosize
                    minRows={3}
                    maxRows={12}
                    value={current.serverNotes}
                    onChange={(event) => setDraft({ ...draft, serverNotes: event.currentTarget.value })}
                    error={guidanceProblem('serverNotes')}
                    disabled={saving}
                />
            </Card>

            {otherProblem && (
                <Text c="red" size="13px">
                    {otherProblem}
                </Text>
            )}

            <Group gap="sm" maw={640}>
                <Button color="brand" onClick={handleSave} loading={saving} disabled={!canSave}>
                    Save changes
                </Button>
                <Button variant="subtle" color="gray" onClick={() => setDraft(undefined)} disabled={pristine || saving}>
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

interface SectionHeadingProps {
    readonly icon: ReactNode;
    readonly title: string;
}

function SectionHeading({ icon, title }: SectionHeadingProps) {
    return (
        <Group gap={8} mb="sm">
            {icon}
            <Text fw={700} size="15px">
                {title}
            </Text>
        </Group>
    );
}
