/**
 * Journeys index for the selected guild.
 *
 * A journey is the set of channels and roles a flow installs. Until now they were only
 * reachable *through* a flow — created implicitly on the first resource save, keyed on
 * the flow's own id — which meant there was nowhere to stand to say "these two flows
 * install the same thing". This page is that somewhere: it lists journeys as
 * first-class rows and shows which flows are attached to each.
 *
 * Shaped after `FlowsListPage` on purpose, down to the loading, empty and error states.
 * An operator moving between the two should not have to relearn where the row actions
 * are, and matching it is worth more than any layout improvement invented here.
 *
 * **Delete refusals are the server's.** `DELETE /journeys/:key` refuses while flows are
 * attached and names every one of them; that message is shown verbatim rather than
 * re-composed, because it is the one that is true at the moment of the attempt. The row
 * disables its own delete button so the refusal is rarely reached, but the two are not
 * the same check and the local one never speaks for the server.
 */

import { useCallback, useEffect, useState } from 'react';
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
    TextInput,
    Title,
    Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
    IconAlertTriangle,
    IconPencil,
    IconPlus,
    IconRoute,
    IconTrash,
    IconUnlink,
} from '@tabler/icons-react';
import { ApiError } from '../api/client';
import {
    createJourney,
    deleteJourney,
    detachFlowFromJourney,
    listJourneys,
    updateJourney,
} from '../api/journeys';
import type { AttachedFlow, JourneySummary } from '../api/types';
import {
    deleteBlockedReason,
    slugifyJourneyName,
    uniqueJourneyKey,
} from '../flows/journeyAttachment';
import { useGuilds } from '../guilds/GuildContext';
import { PAGE_MAX_WIDTH } from '../theme';

function formatUpdated(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
}

/** A flow this page is about to detach, and the journey it is leaving. */
interface PendingDetach {
    readonly journey: JourneySummary;
    readonly flow: AttachedFlow;
}

export function JourneysListPage() {
    const { selected, loading: guildsLoading } = useGuilds();

    const [journeys, setJourneys] = useState<JourneySummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [createOpen, setCreateOpen] = useState(false);
    const [newName, setNewName] = useState('');
    const [creating, setCreating] = useState(false);

    const [renaming, setRenaming] = useState<JourneySummary | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [savingRename, setSavingRename] = useState(false);

    const [pendingDelete, setPendingDelete] = useState<JourneySummary | null>(null);
    const [deleting, setDeleting] = useState(false);

    const [pendingDetach, setPendingDetach] = useState<PendingDetach | null>(null);
    const [detaching, setDetaching] = useState(false);

    const guildId = selected?.id;

    /**
     * Reload the whole list rather than patching a row.
     *
     * Attachments are the point of this page and they are changed from two places — here
     * and the flow builder — so a row patched from a single response would be stale for
     * anything the other surface did. The list is small and the read is three queries.
     */
    const refresh = useCallback(async () => {
        if (!guildId) return;
        setLoading(true);
        setError(null);
        try {
            setJourneys(await listJourneys(guildId));
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Failed to load journeys');
        } finally {
            setLoading(false);
        }
    }, [guildId]);

    useEffect(() => {
        if (!guildId) return;
        let cancelled = false;
        void (async () => {
            setLoading(true);
            setError(null);
            try {
                const rows = await listJourneys(guildId);
                if (!cancelled) setJourneys(rows);
            } catch (err) {
                const message = err instanceof ApiError ? err.message : 'Failed to load journeys';
                if (!cancelled) setError(message);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [guildId]);

    async function handleCreate() {
        if (!guildId) return;
        const name = newName.trim();
        if (!name) return;
        setCreating(true);
        try {
            // Keyed from the name and de-duplicated against what is already here, so the
            // operator names the thing rather than inventing an identifier. The server
            // still owns the constraint — this only keeps the common collision out of
            // the save path.
            const journeyKey = uniqueJourneyKey(
                slugifyJourneyName(name),
                journeys.map((journey) => journey.journeyKey)
            );
            // Created empty. A journey with no resources cannot be installed — the server
            // rejects that at install time, not here — and the resources are authored in
            // the builder's panel, which is where the flow that needs them lives.
            await createJourney(guildId, { journeyKey, name, resources: [] });
            setCreateOpen(false);
            setNewName('');
            await refresh();
        } catch (err) {
            const message = err instanceof ApiError ? err.message : "Couldn't create that journey.";
            notifications.show({ color: 'red', title: 'No dice', message });
        } finally {
            setCreating(false);
        }
    }

    function openRename(journey: JourneySummary): void {
        setRenaming(journey);
        setRenameValue(journey.name);
    }

    async function handleRename() {
        if (!guildId || !renaming) return;
        const name = renameValue.trim();
        if (!name) return;
        setSavingRename(true);
        try {
            // The name only. The key is identity — `resource_bindings` and every link row
            // point at it — so it is deliberately not editable here.
            await updateJourney(guildId, renaming.journeyKey, { name });
            setRenaming(null);
            await refresh();
        } catch (err) {
            const message = err instanceof ApiError ? err.message : "Couldn't rename that.";
            notifications.show({ color: 'red', title: "Couldn't rename", message });
        } finally {
            setSavingRename(false);
        }
    }

    async function handleDelete() {
        if (!guildId || !pendingDelete) return;
        setDeleting(true);
        try {
            await deleteJourney(guildId, pendingDelete.journeyKey);
            notifications.show({
                color: 'brand',
                title: 'Gone',
                message: `"${pendingDelete.name}" has been shown the door.`,
            });
            setPendingDelete(null);
            await refresh();
        } catch (err) {
            // The server's own refusal, verbatim. It names every attached flow, which is
            // what the operator has to act on; re-composing it here would produce a
            // second copy to drift and a vaguer one at that.
            const message = err instanceof ApiError ? err.message : "Couldn't delete that.";
            notifications.show({
                color: 'red',
                title: "Couldn't delete",
                message,
                autoClose: false,
            });
            // Left open deliberately when the refusal names something to go and fix.
            if (!(err instanceof ApiError) || err.status !== 409) setPendingDelete(null);
            await refresh();
        } finally {
            setDeleting(false);
        }
    }

    async function handleDetach() {
        if (!guildId || !pendingDetach) return;
        setDetaching(true);
        try {
            await detachFlowFromJourney(guildId, pendingDetach.flow.flowId);
            notifications.show({
                color: 'brand',
                title: 'Detached',
                message: `"${pendingDetach.flow.name}" no longer installs "${pendingDetach.journey.name}".`,
            });
            setPendingDetach(null);
            await refresh();
        } catch (err) {
            const message = err instanceof ApiError ? err.message : "Couldn't detach that flow.";
            notifications.show({ color: 'red', title: "Couldn't detach", message });
        } finally {
            setDetaching(false);
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

    return (
        <Stack gap="lg" maw={PAGE_MAX_WIDTH}>
            <div>
                <Text size="12.5px" c="dark.2">
                    <Text span c="dark.1" fw={600}>
                        {selected.name}
                    </Text>{' '}
                    › Configure › Journeys
                </Text>
                <Group justify="space-between" align="flex-end" mt={4} wrap="wrap">
                    <div>
                        <Group gap={10}>
                            <IconRoute size={22} color="var(--mantine-color-brand-6)" />
                            <Title order={1} size="24px">
                                Journeys
                            </Title>
                        </Group>
                        <Text c="dimmed" size="13.5px" mt={4} maw={560}>
                            The channels and roles your flows install. Point several flows at one
                            journey and they all share the same setup.
                        </Text>
                    </div>
                    <Button
                        color="brand"
                        leftSection={<IconPlus size={16} />}
                        onClick={() => setCreateOpen(true)}
                    >
                        New journey
                    </Button>
                </Group>
            </div>

            <Card p={0} style={{ overflow: 'hidden' }}>
                {loading ? (
                    <Center py="xl">
                        <Loader color="brand" size="sm" />
                    </Center>
                ) : error ? (
                    <Alert
                        color="red"
                        icon={<IconAlertTriangle size={16} />}
                        title="Couldn't load journeys"
                        m="md"
                    >
                        {error}
                    </Alert>
                ) : journeys.length === 0 ? (
                    <Stack align="center" gap={6} py={48} px="md">
                        <IconRoute size={28} color="var(--mantine-color-dark-3)" />
                        <Text fw={700} size="15px">
                            No journeys yet
                        </Text>
                        <Text c="dimmed" size="13px" ta="center" maw={420}>
                            Every flow that declares resources gets one automatically. Make one
                            here when you want two flows to install the same channels.
                        </Text>
                        <Button
                            mt="sm"
                            color="brand"
                            leftSection={<IconPlus size={16} />}
                            onClick={() => setCreateOpen(true)}
                        >
                            New journey
                        </Button>
                    </Stack>
                ) : (
                    <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>Journey</Table.Th>
                                <Table.Th w={110}>Resources</Table.Th>
                                <Table.Th>Attached flows</Table.Th>
                                <Table.Th w={170}>Last updated</Table.Th>
                                <Table.Th w={110} />
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {journeys.map((journey) => {
                                const blocked = deleteBlockedReason(journey);
                                return (
                                    <Table.Tr key={journey.journeyKey}>
                                        <Table.Td>
                                            <Text fw={600} size="13.5px">
                                                {journey.name}
                                            </Text>
                                            {/*
                                             * The key, quietly, under the name. It is the
                                             * identity every binding and link row points
                                             * at, so an operator debugging an install
                                             * needs to be able to read it — but it is not
                                             * what they scan the list by.
                                             */}
                                            <Text size="11.5px" c="dark.2" ff="monospace">
                                                {journey.journeyKey}
                                            </Text>
                                        </Table.Td>
                                        <Table.Td>
                                            <Badge variant="light" color="gray" radius="xl">
                                                {journey.resourceCount}
                                            </Badge>
                                        </Table.Td>
                                        <Table.Td>
                                            {journey.attachedFlows.length === 0 ? (
                                                <Text size="12.5px" c="dark.2">
                                                    Nothing attached
                                                </Text>
                                            ) : (
                                                <Group gap={6} wrap="wrap">
                                                    {journey.attachedFlows.map((flow) => (
                                                        <Tooltip
                                                            key={flow.flowId}
                                                            label={`Detach ${flow.name}`}
                                                            withArrow
                                                        >
                                                            <Badge
                                                                variant="light"
                                                                color="brand"
                                                                radius="sm"
                                                                rightSection={
                                                                    <IconUnlink size={11} />
                                                                }
                                                                style={{ cursor: 'pointer' }}
                                                                onClick={() =>
                                                                    setPendingDetach({
                                                                        journey,
                                                                        flow,
                                                                    })
                                                                }
                                                            >
                                                                {flow.name}
                                                            </Badge>
                                                        </Tooltip>
                                                    ))}
                                                </Group>
                                            )}
                                        </Table.Td>
                                        <Table.Td>
                                            <Text size="12.5px" c="dark.2">
                                                {formatUpdated(journey.updatedAt)}
                                            </Text>
                                        </Table.Td>
                                        <Table.Td>
                                            <Group gap={6} justify="flex-end" wrap="nowrap">
                                                <Tooltip label="Rename">
                                                    <Button
                                                        size="xs"
                                                        variant="subtle"
                                                        color="gray"
                                                        px={8}
                                                        onClick={() => openRename(journey)}
                                                        aria-label={`Rename ${journey.name}`}
                                                    >
                                                        <IconPencil size={14} />
                                                    </Button>
                                                </Tooltip>
                                                {/*
                                                 * Disabled while flows are attached, with
                                                 * the reason in the tooltip rather than
                                                 * hidden. The server refuses this anyway;
                                                 * disabling it means the operator is told
                                                 * what to do first instead of pressing a
                                                 * button whose only outcome is a banner.
                                                 */}
                                                <Tooltip
                                                    label={blocked ?? 'Delete journey'}
                                                    multiline
                                                    w={260}
                                                >
                                                    <Button
                                                        size="xs"
                                                        variant="subtle"
                                                        color="red"
                                                        px={8}
                                                        data-disabled={
                                                            blocked ? true : undefined
                                                        }
                                                        onClick={() => {
                                                            if (blocked) return;
                                                            setPendingDelete(journey);
                                                        }}
                                                        aria-label={`Delete ${journey.name}`}
                                                    >
                                                        <IconTrash size={14} />
                                                    </Button>
                                                </Tooltip>
                                            </Group>
                                        </Table.Td>
                                    </Table.Tr>
                                );
                            })}
                        </Table.Tbody>
                    </Table>
                )}
            </Card>

            <Modal
                opened={createOpen}
                onClose={() => setCreateOpen(false)}
                title="New journey"
                size="sm"
            >
                <Stack gap="md">
                    <TextInput
                        label="Journey name"
                        description="What this set of channels and roles is for. “Onboarding”, say."
                        placeholder="Onboarding"
                        data-autofocus
                        value={newName}
                        onChange={(e) => setNewName(e.currentTarget.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && newName.trim()) void handleCreate();
                        }}
                    />
                    <Text size="12.5px" c="dimmed">
                        It starts empty. Attach a flow and declare what it needs from that
                        flow&apos;s resources panel.
                    </Text>
                    <Group justify="flex-end" gap="sm">
                        <Button
                            variant="subtle"
                            color="gray"
                            onClick={() => setCreateOpen(false)}
                            disabled={creating}
                        >
                            Cancel
                        </Button>
                        <Button
                            color="brand"
                            loading={creating}
                            disabled={!newName.trim()}
                            onClick={() => void handleCreate()}
                        >
                            Create
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Modal
                opened={renaming !== null}
                onClose={() => setRenaming(null)}
                title="Rename journey"
                size="sm"
            >
                <Stack gap="md">
                    <TextInput
                        label="Journey name"
                        data-autofocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.currentTarget.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && renameValue.trim()) void handleRename();
                        }}
                    />
                    <Text size="12.5px" c="dimmed">
                        The key stays <Text span ff="monospace">{renaming?.journeyKey}</Text> — it
                        is what installed channels are recorded against, so renaming it would
                        lose track of them.
                    </Text>
                    <Group justify="flex-end" gap="sm">
                        <Button
                            variant="subtle"
                            color="gray"
                            onClick={() => setRenaming(null)}
                            disabled={savingRename}
                        >
                            Cancel
                        </Button>
                        <Button
                            color="brand"
                            loading={savingRename}
                            disabled={!renameValue.trim()}
                            onClick={() => void handleRename()}
                        >
                            Save
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Modal
                opened={pendingDelete !== null}
                onClose={() => setPendingDelete(null)}
                title="Delete journey"
                size="md"
            >
                <Stack gap="md">
                    <Text size="13.5px" c="dimmed">
                        <Text span fw={700} c="bright">
                            {pendingDelete?.name}
                        </Text>{' '}
                        and its {pendingDelete?.resourceCount ?? 0} declared resource
                        {pendingDelete?.resourceCount === 1 ? '' : 's'} will be deleted. Anything
                        it already installed stays in your server — removing that is a separate
                        step from a flow that installs it.
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
                        <Button color="red" loading={deleting} onClick={() => void handleDelete()}>
                            Delete journey
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Modal
                opened={pendingDetach !== null}
                onClose={() => setPendingDetach(null)}
                title="Detach flow"
                size="md"
            >
                <Stack gap="md">
                    <Text size="13.5px" c="dimmed">
                        <Text span fw={700} c="bright">
                            {pendingDetach?.flow.name}
                        </Text>{' '}
                        will stop installing{' '}
                        <Text span fw={700} c="bright">
                            {pendingDetach?.journey.name}
                        </Text>
                        . The journey stays, and so does anything it has already put in your
                        server — removing those is a separate step.
                    </Text>
                    <Group justify="flex-end" gap="sm">
                        <Button
                            variant="subtle"
                            color="gray"
                            onClick={() => setPendingDetach(null)}
                            disabled={detaching}
                        >
                            Cancel
                        </Button>
                        <Button
                            color="red"
                            leftSection={<IconUnlink size={16} />}
                            loading={detaching}
                            onClick={() => void handleDetach()}
                        >
                            Detach
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </Stack>
    );
}
