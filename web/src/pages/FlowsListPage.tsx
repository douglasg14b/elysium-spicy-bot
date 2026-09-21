/**
 * Flows index for the selected guild. Lists every flow with an inline enable toggle,
 * plus create/delete. "Edit" hands off to the visual builder at `/flows/:flowId`.
 */

import { useEffect, useState } from 'react';
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
    IconBolt,
    IconPencil,
    IconPlus,
    IconServerCog,
    IconTrash,
} from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
    createFlow,
    deleteFlow,
    getPublishedState,
    listFlows,
    undeployFlow,
    unpublishFlow,
    updateFlow,
} from '../api/flows';
import type { FlowSummary, PublishedFlowState } from '../api/types';
import { summarisePublished, unpublishConfirmLine } from '../flows/publishedSummary';
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

export function FlowsListPage() {
    const { selected, loading: guildsLoading } = useGuilds();
    const navigate = useNavigate();

    const [flows, setFlows] = useState<FlowSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [togglingId, setTogglingId] = useState<string | null>(null);

    const [createOpen, setCreateOpen] = useState(false);
    const [newName, setNewName] = useState('');
    const [creating, setCreating] = useState(false);

    const [pendingDelete, setPendingDelete] = useState<FlowSummary | null>(null);
    const [deleting, setDeleting] = useState(false);

    /**
     * The flow whose published structure is being inspected.
     *
     * Deliberately **not** `pendingDelete`. Taking a channel back out of the server is
     * ordinary maintenance — you provisioned a category, you want it gone — and routing
     * it through the delete dialog meant the only way to reach it was to first say you
     * wanted to destroy the flow. Two different intentions were sharing one door.
     *
     * The delete dialog sets this too, so the "here is what deleting leaves behind"
     * offer still works. One piece of state, two ways in.
     */
    const [managing, setManaging] = useState<FlowSummary | null>(null);
    /** Whether the manage dialog was opened on its own rather than by the delete flow. */
    const [managingAlone, setManagingAlone] = useState(false);

    /**
     * What the managed flow has live in the guild.
     *
     * `null` while it is still loading — distinct from a loaded-but-empty state,
     * because the dialog must not say "this publishes nothing" before it has asked.
     */
    const [published, setPublished] = useState<PublishedFlowState | null>(null);
    const [cleaningUp, setCleaningUp] = useState(false);
    /** The second confirm, for the half that destroys channels rather than messages. */
    const [confirmUnpublish, setConfirmUnpublish] = useState(false);

    // Ask what the flow has published the moment either dialog opens. For a delete that
    // is the dialog's first job — saying what deleting leaves behind; for a standalone
    // manage it is the whole point.
    useEffect(() => {
        if (!selected || !managing) {
            setPublished(null);
            setConfirmUnpublish(false);
            return;
        }

        let cancelled = false;
        void (async () => {
            try {
                const state = await getPublishedState(selected.id, managing.flowId);
                if (!cancelled) setPublished(state);
            } catch {
                // A failed lookup must not block the delete, but it must not silently
                // claim there is nothing published either. An empty state plus the
                // standing "older buttons are invisible" warning is the honest answer.
                if (!cancelled) {
                    setPublished({
                        buttonMessages: [],
                        deletableResources: [],
                        refusedResources: [],
                        mayHaveUnrecordedButtons: true,
                    });
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [selected, managing]);

    useEffect(() => {
        if (!selected) return;
        let cancelled = false;
        void (async () => {
            setLoading(true);
            setError(null);
            try {
                const rows = await listFlows(selected.id);
                if (!cancelled) setFlows(rows);
            } catch (err) {
                const message = err instanceof ApiError ? err.message : 'Failed to load flows';
                if (!cancelled) setError(message);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [selected]);

    // Every decision about what the dialog says lives in `publishedSummary`, which is
    // a plain module and therefore testable — `web/` has no jsdom, so a decision left
    // inside JSX is a decision nothing can check.
    const summary = published ? summarisePublished(published) : null;

    async function handleToggle(flow: FlowSummary, enabled: boolean) {
        if (!selected) return;
        setTogglingId(flow.flowId);
        // Optimistic — revert if the PUT fails.
        setFlows((prev) =>
            prev.map((f) => (f.flowId === flow.flowId ? { ...f, enabled } : f))
        );
        try {
            const updated = await updateFlow(selected.id, flow.flowId, { enabled });
            setFlows((prev) =>
                prev.map((f) =>
                    f.flowId === flow.flowId
                        ? { ...f, enabled: updated.enabled, updatedAt: updated.updatedAt }
                        : f
                )
            );
        } catch (err) {
            setFlows((prev) =>
                prev.map((f) =>
                    f.flowId === flow.flowId ? { ...f, enabled: flow.enabled } : f
                )
            );
            const message =
                err instanceof ApiError ? err.message : "Couldn't change that. Try again.";
            notifications.show({ color: 'red', title: "Couldn't update flow", message });
        } finally {
            setTogglingId(null);
        }
    }

    async function handleCreate() {
        if (!selected) return;
        const name = newName.trim();
        if (!name) return;
        setCreating(true);
        try {
            const flow = await createFlow(selected.id, name);
            setCreateOpen(false);
            setNewName('');
            navigate(`/flows/${flow.flowId}`);
        } catch (err) {
            const message =
                err instanceof ApiError ? err.message : "Couldn't create that flow.";
            notifications.show({ color: 'red', title: 'No dice', message });
        } finally {
            setCreating(false);
        }
    }

    /**
     * Take the flow's buttons out of their channels.
     *
     * Its own action, not a step inside delete. The flow row survives it, so an
     * operator can retire a live button without throwing the flow away.
     */
    async function handleUndeploy() {
        if (!selected || !managing) return;
        setCleaningUp(true);
        try {
            const { results } = await undeployFlow(selected.id, managing.flowId);
            const failed = results.filter((result) => result.outcome === 'failed');
            const gone = results.length - failed.length;

            notifications.show({
                color: failed.length > 0 ? 'orange' : 'brand',
                title: failed.length > 0 ? 'Mostly gone' : 'Buttons retired',
                message:
                    failed.length > 0
                        ? `${gone} removed, ${failed.length} wouldn't budge: ${failed[0].explanation ?? 'Discord said no.'}`
                        : `${gone} button message${gone === 1 ? '' : 's'} taken down.`,
            });

            setPublished(await getPublishedState(selected.id, managing.flowId));
        } catch (err) {
            const message =
                err instanceof ApiError ? err.message : "Couldn't take those buttons down.";
            notifications.show({ color: 'red', title: 'Still up', message });
        } finally {
            setCleaningUp(false);
        }
    }

    /** Inspect what a flow has live, without proposing to delete the flow itself. */
    function openManage(flow: FlowSummary): void {
        setManagingAlone(true);
        setManaging(flow);
    }

    /** Propose deleting a flow, which also inspects what that would leave behind. */
    function openDelete(flow: FlowSummary): void {
        setManagingAlone(false);
        setPendingDelete(flow);
        setManaging(flow);
    }

    function closeManage(): void {
        setManaging(null);
        setPendingDelete(null);
        setManagingAlone(false);
    }

    /**
     * Destroy the channels and roles the flow's journey created.
     *
     * Behind its own confirm, because this is the only action here that deletes part of
     * a live server and cannot be undone.
     */
    async function handleUnpublish() {
        if (!selected || !managing) return;
        setCleaningUp(true);
        try {
            const { results } = await unpublishFlow(selected.id, managing.flowId);
            const deleted = results.filter((result) => result.outcome === 'deleted').length;
            const failed = results.filter((result) => result.outcome === 'failed');

            notifications.show({
                color: failed.length > 0 ? 'orange' : 'brand',
                title: failed.length > 0 ? 'Partly done' : 'Unpublished',
                message:
                    failed.length > 0
                        ? `${deleted} deleted; ${failed.length} refused: ${failed[0].explanation ?? 'Discord said no.'}`
                        : `${deleted} thing${deleted === 1 ? '' : 's'} deleted from the server. Anything adopted was left exactly where it was.`,
            });

            setConfirmUnpublish(false);
            setPublished(await getPublishedState(selected.id, managing.flowId));
        } catch (err) {
            const message =
                err instanceof ApiError ? err.message : "Couldn't unpublish those resources.";
            notifications.show({ color: 'red', title: 'Nothing deleted', message });
        } finally {
            setCleaningUp(false);
        }
    }

    async function handleDelete() {
        if (!selected || !pendingDelete) return;
        setDeleting(true);
        try {
            await deleteFlow(selected.id, pendingDelete.flowId);
            setFlows((prev) => prev.filter((f) => f.flowId !== pendingDelete.flowId));
            notifications.show({
                color: 'brand',
                title: 'Gone',
                message: `"${pendingDelete.name}" has been shown the door.`,
            });
            // Closes both halves. The modal is keyed on `managing` now, so clearing
            // only `pendingDelete` would leave it open over a flow that is gone.
            closeManage();
        } catch (err) {
            const message = err instanceof ApiError ? err.message : "Couldn't delete that flow.";
            notifications.show({ color: 'red', title: "Couldn't delete", message });
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

    return (
        <Stack gap="lg" maw={PAGE_MAX_WIDTH}>
            <div>
                <Text size="12.5px" c="dark.2">
                    <Text span c="dark.1" fw={600}>
                        {selected.name}
                    </Text>{' '}
                    › Configure › Flows
                </Text>
                <Group justify="space-between" align="flex-end" mt={4} wrap="wrap">
                    <div>
                        <Group gap={10}>
                            <IconBolt size={22} color="var(--mantine-color-brand-6)" />
                            <Title order={1} size="24px">
                                Flows
                            </Title>
                        </Group>
                        <Text c="dimmed" size="13.5px" mt={4} maw={540}>
                            Build onboarding, reaction roles &amp; more — no code. Drag, drop, done.
                        </Text>
                    </div>
                    <Button
                        color="brand"
                        leftSection={<IconPlus size={16} />}
                        onClick={() => setCreateOpen(true)}
                    >
                        New flow
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
                        title="Couldn't load flows"
                        m="md"
                    >
                        {error}
                    </Alert>
                ) : flows.length === 0 ? (
                    <Stack align="center" gap={6} py={48} px="md">
                        <IconBolt size={28} color="var(--mantine-color-dark-3)" />
                        <Text fw={700} size="15px">
                            No flows yet
                        </Text>
                        <Text c="dimmed" size="13px" ta="center" maw={380}>
                            Your server runs on vibes alone right now. Build your first flow and let
                            the bot do the boring parts.
                        </Text>
                        <Button
                            mt="sm"
                            color="brand"
                            leftSection={<IconPlus size={16} />}
                            onClick={() => setCreateOpen(true)}
                        >
                            New flow
                        </Button>
                    </Stack>
                ) : (
                    <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>Flow</Table.Th>
                                <Table.Th w={110}>Nodes</Table.Th>
                                <Table.Th w={170}>Last updated</Table.Th>
                                <Table.Th w={120}>Enabled</Table.Th>
                                <Table.Th w={140} />
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {flows.map((flow) => (
                                <Table.Tr key={flow.flowId}>
                                    <Table.Td>
                                        <Text fw={600} size="13.5px">
                                            {flow.name}
                                        </Text>
                                    </Table.Td>
                                    <Table.Td>
                                        <Badge variant="light" color="gray" radius="xl">
                                            {flow.nodeCount}
                                        </Badge>
                                    </Table.Td>
                                    <Table.Td>
                                        <Text size="12.5px" c="dark.2">
                                            {formatUpdated(flow.updatedAt)}
                                        </Text>
                                    </Table.Td>
                                    <Table.Td>
                                        <Switch
                                            color="green"
                                            checked={flow.enabled}
                                            disabled={togglingId === flow.flowId}
                                            onChange={(e) =>
                                                void handleToggle(flow, e.currentTarget.checked)
                                            }
                                            aria-label={`Enable ${flow.name}`}
                                        />
                                    </Table.Td>
                                    <Table.Td>
                                        <Group gap={6} justify="flex-end" wrap="nowrap">
                                            <Button
                                                size="xs"
                                                variant="light"
                                                color="brand"
                                                leftSection={<IconPencil size={14} />}
                                                onClick={() => navigate(`/flows/${flow.flowId}`)}
                                            >
                                                Edit
                                            </Button>
                                            <Tooltip label="What it put in your server">
                                                <Button
                                                    size="xs"
                                                    variant="subtle"
                                                    color="gray"
                                                    px={8}
                                                    onClick={() => openManage(flow)}
                                                    aria-label={`Manage what ${flow.name} published`}
                                                >
                                                    <IconServerCog size={14} />
                                                </Button>
                                            </Tooltip>
                                            <Tooltip label="Delete flow">
                                                <Button
                                                    size="xs"
                                                    variant="subtle"
                                                    color="red"
                                                    px={8}
                                                    onClick={() => openDelete(flow)}
                                                    aria-label={`Delete ${flow.name}`}
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

            <Modal
                opened={createOpen}
                onClose={() => setCreateOpen(false)}
                title="New flow"
                size="sm"
            >
                <Stack gap="md">
                    <TextInput
                        label="Flow name"
                        description="Something you'll recognise later. “Onboarding”, say."
                        placeholder="Onboarding"
                        data-autofocus
                        value={newName}
                        onChange={(e) => setNewName(e.currentTarget.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && newName.trim()) void handleCreate();
                        }}
                    />
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
                            Create &amp; open
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Modal
                opened={managing !== null}
                onClose={closeManage}
                title={managingAlone ? 'What this flow put in your server' : 'Delete this flow?'}
                size="md"
            >
                <Stack gap="md">
                    {managingAlone ? (
                        <Text size="13.5px" c="dimmed">
                            Channels, roles and buttons{' '}
                            <Text span fw={700} c="bright">
                                {managing?.name}
                            </Text>{' '}
                            has live right now. Taking them back is permanent — anything it
                            adopted instead of creating stays put.
                        </Text>
                    ) : (
                        <Text size="13.5px" c="dimmed">
                            <Text span fw={700} c="bright">
                                {pendingDelete?.name}
                            </Text>{' '}
                            and its {pendingDelete?.nodeCount ?? 0} node
                            {pendingDelete?.nodeCount === 1 ? '' : 's'} will be deleted for good.
                            No undo, no take-backs.
                        </Text>
                    )}

                    {managingAlone && published && summary && !summary.hasAnything && (
                        <Text size="13.5px" c="dimmed">
                            Nothing live in the server. Install it from the builder first.
                        </Text>
                    )}

                    {/*
                     * What the delete leaves behind, and the cleanup offered beside it
                     * rather than folded into it. Deleting a flow deliberately touches
                     * nothing in the server — an operator who wants the channels gone
                     * has to say so, separately and on purpose.
                     */}
                    {published && summary && summary.hasAnything && (
                        <Alert
                            color="orange"
                            icon={<IconAlertTriangle size={16} />}
                            title={
                                managingAlone
                                    ? 'Live in your server right now'
                                    : 'This flow left things in your server'
                            }
                        >
                            <Stack gap="xs">
                                {summary.leftBehind && !managingAlone && (
                                    <Text size="13px">
                                        Deleting the flow does not remove {summary.leftBehind}.
                                        They stay exactly where they are.
                                    </Text>
                                )}
                                {summary.leftBehind && managingAlone && (
                                    <Text size="13px">
                                        This flow has {summary.leftBehind} in the server.
                                    </Text>
                                )}

                                {summary.refusals.length > 0 && (
                                    <Stack gap={4}>
                                        <Text size="12.5px" fw={600}>
                                            Off limits, and staying that way:
                                        </Text>
                                        {summary.refusals.map((refusal, index) => (
                                            <Text key={index} size="12.5px" c="dimmed">
                                                • {refusal}
                                            </Text>
                                        ))}
                                    </Stack>
                                )}

                                {summary.unrecordedWarning && (
                                    <Text size="12px" c="dimmed" fs="italic">
                                        {summary.unrecordedWarning}
                                    </Text>
                                )}

                                <Group gap="sm" mt={4}>
                                    {summary.canUndeploy && (
                                        <Button
                                            size="xs"
                                            variant="light"
                                            color="orange"
                                            loading={cleaningUp}
                                            onClick={() => void handleUndeploy()}
                                        >
                                            Take the buttons down
                                        </Button>
                                    )}
                                    {summary.canUnpublish && !confirmUnpublish && (
                                        <Button
                                            size="xs"
                                            variant="light"
                                            color="red"
                                            disabled={cleaningUp}
                                            onClick={() => setConfirmUnpublish(true)}
                                        >
                                            Delete what it created
                                        </Button>
                                    )}
                                </Group>

                                {/*
                                 * The second confirm. Everything above this point is
                                 * reversible or merely tidy; this deletes real channels
                                 * and roles, so it names exactly what goes.
                                 */}
                                {confirmUnpublish && published && (
                                    <Stack gap="xs" mt={4}>
                                        <Text size="12.5px" fw={600} c="red.4">
                                            {unpublishConfirmLine(published.deletableResources)}
                                        </Text>
                                        <Group gap="sm">
                                            <Button
                                                size="xs"
                                                variant="subtle"
                                                color="gray"
                                                disabled={cleaningUp}
                                                onClick={() => setConfirmUnpublish(false)}
                                            >
                                                Back off
                                            </Button>
                                            <Button
                                                size="xs"
                                                color="red"
                                                loading={cleaningUp}
                                                onClick={() => void handleUnpublish()}
                                            >
                                                Yes, delete them
                                            </Button>
                                        </Group>
                                    </Stack>
                                )}
                            </Stack>
                        </Alert>
                    )}

                    {/*
                     * No "Delete flow" when this was opened on its own. Putting it here
                     * would reintroduce the problem in reverse — someone tidying up a
                     * category would find the button that destroys the flow sitting
                     * under their cursor.
                     */}
                    <Group justify="flex-end" gap="sm">
                        <Button
                            variant="subtle"
                            color="gray"
                            onClick={closeManage}
                            disabled={deleting || cleaningUp}
                        >
                            {managingAlone ? 'Done' : 'Keep it'}
                        </Button>
                        {!managingAlone && (
                            <Button
                                color="red"
                                loading={deleting}
                                disabled={cleaningUp}
                                onClick={() => void handleDelete()}
                            >
                                Delete flow
                            </Button>
                        )}
                    </Group>
                </Stack>
            </Modal>
        </Stack>
    );
}
