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
    IconTrash,
} from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { createFlow, deleteFlow, listFlows, updateFlow } from '../api/flows';
import type { FlowSummary } from '../api/types';
import { useGuilds } from '../guilds/GuildContext';

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
            setPendingDelete(null);
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
        <Stack gap="lg" maw={1100}>
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
                                            <Tooltip label="Delete flow">
                                                <Button
                                                    size="xs"
                                                    variant="subtle"
                                                    color="red"
                                                    px={8}
                                                    onClick={() => setPendingDelete(flow)}
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
                opened={pendingDelete !== null}
                onClose={() => setPendingDelete(null)}
                title="Delete this flow?"
                size="sm"
            >
                <Stack gap="md">
                    <Text size="13.5px" c="dimmed">
                        <Text span fw={700} c="bright">
                            {pendingDelete?.name}
                        </Text>{' '}
                        and its {pendingDelete?.nodeCount ?? 0} node
                        {pendingDelete?.nodeCount === 1 ? '' : 's'} will be deleted for good. No
                        undo, no take-backs.
                    </Text>
                    <Group justify="flex-end" gap="sm">
                        <Button
                            variant="subtle"
                            color="gray"
                            onClick={() => setPendingDelete(null)}
                            disabled={deleting}
                        >
                            Keep it
                        </Button>
                        <Button color="red" loading={deleting} onClick={() => void handleDelete()}>
                            Delete flow
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </Stack>
    );
}
