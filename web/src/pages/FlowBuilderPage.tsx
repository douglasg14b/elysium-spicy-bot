/**
 * The visual flow builder: palette | canvas | inspector, with a toolbar on top.
 * Canvas state lives in React Flow's node/edge state; on save we serialise it back
 * into the engine's `FlowGraph` (version 1) and PUT it.
 *
 * Layout matches `flow-builder.mockup.html`. Undo/redo is a plain snapshot stack.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Background,
    BackgroundVariant,
    Controls,
    MiniMap,
    ReactFlow,
    ReactFlowProvider,
    addEdge,
    useEdgesState,
    useNodesState,
    useReactFlow,
    type Connection,
    type Edge,
    type NodeTypes,
    type OnConnect,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
    ActionIcon,
    Alert,
    Button,
    Center,
    Group,
    Loader,
    Modal,
    Select,
    Stack,
    Switch,
    Text,
    TextInput,
    Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
    IconArrowBackUp,
    IconArrowForwardUp,
    IconChevronLeft,
    IconDeviceFloppy,
    IconRocket,
} from '@tabler/icons-react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { getGuildChannels } from '../api/config';
import { deployFlow, getFlow, getGuildRoles, getNodeTypes, updateFlow } from '../api/flows';
import type {
    FlowEdge,
    FlowGraph,
    GuildChannel,
    GuildRole,
    NodeDescriptor,
} from '../api/types';
import { FlowNodeCard, type FlowCardNode, type FlowNodeCardData } from '../flows/FlowNodeCard';
import { NodePalette, NODE_DRAG_MIME } from '../flows/NodePalette';
import { NodeInspector } from '../flows/NodeInspector';
import { defaultDataFor, emptyGraph, isCondition } from '../flows/nodeMeta';
import { useGuilds } from '../guilds/GuildContext';

const nodeTypes: NodeTypes = { flowCard: FlowNodeCard };

/** Edge styling: condition branches inherit their handle's colour. */
function styleEdge(edge: Edge): Edge {
    const isFalse = edge.sourceHandle === 'false';
    const isTrue = edge.sourceHandle === 'true';
    const stroke = isTrue ? '#43b581' : isFalse ? '#ed4245' : '#5b5f6d';
    return {
        ...edge,
        animated: true,
        style: { stroke, strokeWidth: 2.5 },
        label: isTrue ? 'true' : isFalse ? 'false' : undefined,
        labelStyle: { fill: stroke, fontSize: 10, fontWeight: 700 },
        labelBgStyle: { fill: '#1a1b23' },
    };
}

/** A graph snapshot for the undo stack. */
interface Snapshot {
    nodes: FlowCardNode[];
    edges: Edge[];
}

export function FlowBuilderPage() {
    return (
        <ReactFlowProvider>
            <FlowBuilder />
        </ReactFlowProvider>
    );
}

function FlowBuilder() {
    const { flowId } = useParams<{ flowId: string }>();
    const { selected, loading: guildsLoading } = useGuilds();
    const navigate = useNavigate();
    const { screenToFlowPosition } = useReactFlow();

    const [nodes, setNodes, onNodesChange] = useNodesState<FlowCardNode>([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

    const [nodeCatalog, setNodeCatalog] = useState<NodeDescriptor[]>([]);
    const [roles, setRoles] = useState<GuildRole[]>([]);
    const [channels, setChannels] = useState<GuildChannel[]>([]);

    const [name, setName] = useState('');
    const [enabled, setEnabled] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

    const [deployOpen, setDeployOpen] = useState(false);
    const [deployChannelId, setDeployChannelId] = useState<string | null>(null);
    const [deploying, setDeploying] = useState(false);

    // Undo/redo snapshot stacks. `skipHistory` guards the programmatic restores.
    const past = useRef<Snapshot[]>([]);
    const future = useRef<Snapshot[]>([]);
    const skipHistory = useRef(false);
    const [historyTick, setHistoryTick] = useState(0);

    // Mirror the latest graph in refs so history capture never reads a stale closure
    // (`onNodesChange` mutates state outside of `pushHistory`).
    const latest = useRef<Snapshot>({ nodes: [], edges: [] });
    useEffect(() => {
        latest.current = { nodes, edges };
    }, [nodes, edges]);

    /** Push the current graph onto the undo stack before a mutating change. */
    const pushHistory = useCallback(() => {
        if (skipHistory.current) return;
        past.current.push({
            nodes: structuredClone(latest.current.nodes),
            edges: structuredClone(latest.current.edges),
        });
        if (past.current.length > 50) past.current.shift();
        future.current = [];
        setHistoryTick((t) => t + 1);
        setDirty(true);
    }, []);

    /* ----------------------------- load ----------------------------- */
    useEffect(() => {
        if (!selected || !flowId) return;
        let cancelled = false;
        void (async () => {
            setLoading(true);
            setError(null);
            try {
                const [flow, catalog, guildRoles, guildChannels] = await Promise.all([
                    getFlow(selected.id, flowId),
                    getNodeTypes(),
                    getGuildRoles(selected.id),
                    getGuildChannels(selected.id),
                ]);
                if (cancelled) return;

                setNodeCatalog(catalog);
                setRoles(guildRoles);
                setChannels(guildChannels);
                setName(flow.name);
                setEnabled(flow.enabled);

                const graph = flow.graph ?? emptyGraph();
                const labelFor = (type: string): string =>
                    catalog.find((c) => c.type === type)?.label ?? type;

                skipHistory.current = true;
                setNodes(
                    graph.nodes.map((n) => ({
                        id: n.id,
                        type: 'flowCard' as const,
                        position: n.position,
                        data: {
                            nodeType: n.type,
                            label: labelFor(n.type),
                            config: n.data ?? {},
                            roles: guildRoles,
                            channels: guildChannels,
                        } satisfies FlowNodeCardData,
                    }))
                );
                setEdges(
                    graph.edges.map((e) =>
                        styleEdge({
                            id: e.id,
                            source: e.source,
                            target: e.target,
                            sourceHandle: e.sourceHandle ?? null,
                            targetHandle: e.targetHandle ?? null,
                        })
                    )
                );
                past.current = [];
                future.current = [];
                setDirty(false);
                setHistoryTick((t) => t + 1);
                // Let the state flush before re-arming history capture.
                requestAnimationFrame(() => {
                    skipHistory.current = false;
                });
            } catch (err) {
                const message = err instanceof ApiError ? err.message : 'Failed to load flow';
                if (!cancelled) setError(message);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [selected, flowId, setNodes, setEdges]);

    /* --------------------------- mutations --------------------------- */

    const addNode = useCallback(
        (entry: NodeDescriptor, position?: { x: number; y: number }) => {
            pushHistory();
            const id = `${entry.type.split('.')[1] ?? 'node'}-${Date.now().toString(36)}`;
            const node: FlowCardNode = {
                id,
                type: 'flowCard',
                position: position ?? { x: 120 + Math.random() * 120, y: 120 + Math.random() * 120 },
                data: {
                    nodeType: entry.type,
                    label: entry.label,
                    config: defaultDataFor(entry.type),
                    roles,
                    channels,
                },
            };
            setNodes((prev) => [...prev, node]);
            setSelectedNodeId(id);
        },
        [pushHistory, roles, channels, setNodes]
    );

    const onConnect: OnConnect = useCallback(
        (connection: Connection) => {
            pushHistory();
            // Style only the edge we just created; `addEdge` leaves the rest untouched.
            const id = `e-${connection.source}${connection.sourceHandle ?? ''}-${connection.target}`;
            setEdges((prev) => addEdge(styleEdge({ ...connection, id }), prev));
        },
        [pushHistory, setEdges]
    );

    const onDragOver = useCallback((event: React.DragEvent) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
    }, []);

    const onDrop = useCallback(
        (event: React.DragEvent) => {
            event.preventDefault();
            const type = event.dataTransfer.getData(NODE_DRAG_MIME);
            if (!type) return;
            const entry = nodeCatalog.find((c) => c.type === type);
            if (!entry) return;
            const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
            addNode(entry, position);
        },
        [nodeCatalog, screenToFlowPosition, addNode]
    );

    /** Live-edit the selected node's engine `data`. */
    const updateNodeConfig = useCallback(
        (patch: Record<string, unknown>) => {
            if (!selectedNodeId) return;
            pushHistory();
            setNodes((prev) =>
                prev.map((n) =>
                    n.id === selectedNodeId
                        ? { ...n, data: { ...n.data, config: { ...n.data.config, ...patch } } }
                        : n
                )
            );
        },
        [selectedNodeId, pushHistory, setNodes]
    );

    const deleteSelectedNode = useCallback(() => {
        if (!selectedNodeId) return;
        pushHistory();
        setNodes((prev) => prev.filter((n) => n.id !== selectedNodeId));
        setEdges((prev) =>
            prev.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId)
        );
        setSelectedNodeId(null);
    }, [selectedNodeId, pushHistory, setNodes, setEdges]);

    /* ---------------------------- history ---------------------------- */

    const restore = useCallback(
        (snapshot: Snapshot) => {
            skipHistory.current = true;
            setNodes(snapshot.nodes);
            setEdges(snapshot.edges);
            setDirty(true);
            requestAnimationFrame(() => {
                skipHistory.current = false;
            });
        },
        [setNodes, setEdges]
    );

    const undo = useCallback(() => {
        const previous = past.current.pop();
        if (!previous) return;
        future.current.push({
            nodes: structuredClone(latest.current.nodes),
            edges: structuredClone(latest.current.edges),
        });
        restore(previous);
        setHistoryTick((t) => t + 1);
    }, [restore]);

    const redo = useCallback(() => {
        const next = future.current.pop();
        if (!next) return;
        past.current.push({
            nodes: structuredClone(latest.current.nodes),
            edges: structuredClone(latest.current.edges),
        });
        restore(next);
        setHistoryTick((t) => t + 1);
    }, [restore]);

    /* ------------------------------ save ------------------------------ */

    const serialize = useCallback((): FlowGraph => {
        const liveIds = new Set(nodes.map((n) => n.id));
        return {
            version: 1,
            nodes: nodes.map((n) => ({
                id: n.id,
                type: n.data.nodeType,
                position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
                data: n.data.config,
            })),
            // Drop any edge whose endpoints no longer exist — the backend rejects
            // dangling edges, and undo/redo can briefly leave them behind.
            edges: edges
                .filter((e) => liveIds.has(e.source) && liveIds.has(e.target))
                .map((e) => {
                    const edge: FlowEdge = { id: e.id, source: e.source, target: e.target };
                    if (e.sourceHandle) edge.sourceHandle = e.sourceHandle;
                    if (e.targetHandle) edge.targetHandle = e.targetHandle;
                    return edge;
                }),
        };
    }, [nodes, edges]);

    async function handleSave() {
        if (!selected || !flowId) return;
        setSaving(true);
        try {
            const updated = await updateFlow(selected.id, flowId, {
                name: name.trim() || 'Untitled flow',
                graph: serialize(),
            });
            setName(updated.name);
            setEnabled(updated.enabled);
            setDirty(false);
            notifications.show({
                color: 'brand',
                title: 'Saved',
                message: `"${updated.name}" is locked in.`,
            });
        } catch (err) {
            // 400s carry the engine's validation message (bad node data, dangling
            // edges). Cycles are allowed now — loops are guarded by the visit cap.
            const message =
                err instanceof ApiError ? err.message : "Couldn't save. Try again in a second.";
            notifications.show({ color: 'red', title: "That graph won't fly", message });
        } finally {
            setSaving(false);
        }
    }

    async function handleToggleEnabled(next: boolean) {
        if (!selected || !flowId) return;
        const previous = enabled;
        setEnabled(next);
        try {
            await updateFlow(selected.id, flowId, { enabled: next });
        } catch (err) {
            setEnabled(previous);
            const message = err instanceof ApiError ? err.message : "Couldn't change that.";
            notifications.show({ color: 'red', title: "Couldn't update flow", message });
        }
    }

    async function handleDeploy() {
        if (!selected || !flowId || !deployChannelId) return;
        setDeploying(true);
        try {
            await deployFlow(selected.id, flowId, deployChannelId);
            setDeployOpen(false);
            notifications.show({
                color: 'brand',
                title: 'Deployed',
                message: 'Your button is live. Go press it.',
            });
        } catch (err) {
            const message = err instanceof ApiError ? err.message : "Couldn't deploy that flow.";
            notifications.show({ color: 'red', title: 'Deploy failed', message });
        } finally {
            setDeploying(false);
        }
    }

    /* ---------------------------- derived ---------------------------- */

    const selectedNode = useMemo(
        () => nodes.find((n) => n.id === selectedNodeId) ?? null,
        [nodes, selectedNodeId]
    );

    /** Deploy only makes sense when there's a button to post. */
    const hasButtonTrigger = useMemo(
        () => nodes.some((n) => n.data.nodeType === 'trigger.buttonClick'),
        [nodes]
    );

    const channelOptions = useMemo(
        () => channels.map((ch) => ({ value: ch.id, label: `# ${ch.name}` })),
        [channels]
    );

    // Stack depth lives in refs, so `historyTick` is what triggers the re-render that
    // recomputes these. It is bumped on every history mutation.
    void historyTick;
    const canUndo = past.current.length > 0;
    const canRedo = future.current.length > 0;

    if (guildsLoading || loading) {
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

    if (error) {
        return (
            <Stack gap="md" maw={600}>
                <Alert color="red" title="Couldn't load this flow">
                    {error}
                </Alert>
                <Button
                    variant="light"
                    color="gray"
                    leftSection={<IconChevronLeft size={16} />}
                    onClick={() => navigate('/flows')}
                    w="fit-content"
                >
                    Back to flows
                </Button>
            </Stack>
        );
    }

    return (
        /*
         * The builder owns its whole area, so it cancels AppShell's gutter. Main clears
         * the header with padding (not margin), so a negative margin of one padding unit
         * removes the gutter while leaving that offset intact. Both values reference
         * AppShell's own variables, so they stay correct if `padding` or the header
         * height changes.
         */
        <Stack
            gap={0}
            m="calc(var(--app-shell-padding) * -1)"
            h="calc(100dvh - var(--app-shell-header-offset, 0rem) - var(--app-shell-footer-offset, 0rem))"
        >
            {/* Toolbar */}
            <Group
                h={52}
                px="md"
                gap={8}
                wrap="nowrap"
                bg="dark.8"
                style={{ borderBottom: '1px solid var(--mantine-color-dark-5)', flexShrink: 0 }}
            >
                <Tooltip label="Back to flows">
                    <ActionIcon
                        variant="subtle"
                        color="gray"
                        onClick={() => navigate('/flows')}
                        aria-label="Back to flows"
                    >
                        <IconChevronLeft size={18} />
                    </ActionIcon>
                </Tooltip>

                <TextInput
                    value={name}
                    onChange={(e) => {
                        setName(e.currentTarget.value);
                        setDirty(true);
                    }}
                    placeholder="Untitled flow"
                    variant="unstyled"
                    w={220}
                    styles={{ input: { fontWeight: 700, fontSize: 14 } }}
                    aria-label="Flow name"
                />

                <Tooltip label="Undo">
                    <ActionIcon
                        variant="default"
                        onClick={undo}
                        disabled={!canUndo}
                        aria-label="Undo"
                    >
                        <IconArrowBackUp size={16} />
                    </ActionIcon>
                </Tooltip>
                <Tooltip label="Redo">
                    <ActionIcon
                        variant="default"
                        onClick={redo}
                        disabled={!canRedo}
                        aria-label="Redo"
                    >
                        <IconArrowForwardUp size={16} />
                    </ActionIcon>
                </Tooltip>

                <Button
                    color="brand"
                    size="xs"
                    leftSection={<IconDeviceFloppy size={15} />}
                    onClick={() => void handleSave()}
                    loading={saving}
                    disabled={!dirty || saving}
                >
                    Save
                </Button>

                <Tooltip
                    label={
                        hasButtonTrigger
                            ? 'Post this flow’s button to a channel'
                            : 'Add a Button Click trigger first'
                    }
                >
                    <Button
                        variant="light"
                        color="brand"
                        size="xs"
                        leftSection={<IconRocket size={15} />}
                        onClick={() => setDeployOpen(true)}
                        disabled={!hasButtonTrigger}
                        data-disabled={!hasButtonTrigger || undefined}
                    >
                        Deploy
                    </Button>
                </Tooltip>

                <Switch
                    ml={4}
                    size="sm"
                    color="green"
                    label="Enabled"
                    checked={enabled}
                    onChange={(e) => void handleToggleEnabled(e.currentTarget.checked)}
                    styles={{ label: { fontSize: 12.5, fontWeight: 600 } }}
                />

                <Text size="12px" c={dirty ? 'yellow.5' : 'dark.2'} ml="auto">
                    {dirty ? 'Unsaved changes' : 'All changes saved'}
                </Text>
            </Group>

            {/* Palette | Canvas | Inspector */}
            <Group gap={0} align="stretch" wrap="nowrap" style={{ flex: 1, minHeight: 0 }}>
                <div
                    style={{
                        width: 232,
                        flexShrink: 0,
                        background: 'var(--mantine-color-dark-8)',
                        borderRight: '1px solid var(--mantine-color-dark-5)',
                    }}
                >
                    <NodePalette nodeTypes={nodeCatalog} onAdd={(entry) => addNode(entry)} />
                </div>

                <div style={{ flex: 1, minWidth: 0, background: '#16171d' }} onDrop={onDrop} onDragOver={onDragOver}>
                    <ReactFlow<FlowCardNode, Edge>
                        nodes={nodes}
                        edges={edges}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onConnect={onConnect}
                        nodeTypes={nodeTypes}
                        onNodeClick={(_, node) => setSelectedNodeId(node.id)}
                        onPaneClick={() => setSelectedNodeId(null)}
                        onNodeDragStart={() => pushHistory()}
                        onEdgesDelete={() => setDirty(true)}
                        onNodesDelete={() => setDirty(true)}
                        fitView
                        proOptions={{ hideAttribution: true }}
                        defaultEdgeOptions={{ animated: true }}
                    >
                        <Background
                            variant={BackgroundVariant.Dots}
                            gap={22}
                            size={1}
                            color="rgba(255,255,255,0.14)"
                        />
                        <Controls
                            style={{
                                background: 'var(--mantine-color-dark-7)',
                                border: '1px solid var(--mantine-color-dark-5)',
                                borderRadius: 8,
                            }}
                        />
                        <MiniMap
                            pannable
                            zoomable
                            style={{
                                background: 'var(--mantine-color-dark-8)',
                                border: '1px solid var(--mantine-color-dark-5)',
                                borderRadius: 8,
                            }}
                            maskColor="rgba(22,23,29,0.75)"
                            nodeColor={(node) => {
                                const type = (node.data as FlowNodeCardData).nodeType;
                                if (type.startsWith('trigger.')) return '#43b581';
                                if (isCondition(type)) return '#faa61a';
                                return '#00a2ff';
                            }}
                        />
                    </ReactFlow>
                </div>

                <div
                    style={{
                        width: 300,
                        flexShrink: 0,
                        background: 'var(--mantine-color-dark-8)',
                        borderLeft: '1px solid var(--mantine-color-dark-5)',
                        overflow: 'hidden',
                    }}
                >
                    {selectedNode ? (
                        <NodeInspector
                            key={selectedNode.id}
                            nodeType={selectedNode.data.nodeType}
                            label={selectedNode.data.label}
                            config={selectedNode.data.config}
                            roles={roles}
                            channels={channels}
                            onChange={updateNodeConfig}
                            onDelete={deleteSelectedNode}
                        />
                    ) : (
                        <Stack align="center" justify="center" h="100%" gap={6} px="lg">
                            <Text fw={700} size="14px">
                                Nothing selected
                            </Text>
                            <Text size="12.5px" c="dimmed" ta="center">
                                Drag a node from the left, then click it to configure. The canvas
                                won&apos;t bite.
                            </Text>
                        </Stack>
                    )}
                </div>
            </Group>

            <Modal
                opened={deployOpen}
                onClose={() => setDeployOpen(false)}
                title="Deploy flow"
                size="sm"
            >
                <Stack gap="md">
                    <Text size="13px" c="dimmed">
                        Posts this flow&apos;s button message into a channel. Members click it, the
                        flow runs.
                    </Text>
                    <Select
                        label="Channel"
                        placeholder="Pick a channel"
                        data={channelOptions}
                        value={deployChannelId}
                        onChange={setDeployChannelId}
                        searchable
                        nothingFoundMessage="No channels found"
                        allowDeselect={false}
                    />
                    {dirty && (
                        <Alert color="yellow" variant="light" p="xs">
                            <Text size="12px">
                                You have unsaved changes — deploy posts the last saved version.
                            </Text>
                        </Alert>
                    )}
                    <Group justify="flex-end" gap="sm">
                        <Button
                            variant="subtle"
                            color="gray"
                            onClick={() => setDeployOpen(false)}
                            disabled={deploying}
                        >
                            Cancel
                        </Button>
                        <Button
                            color="brand"
                            loading={deploying}
                            disabled={!deployChannelId}
                            onClick={() => void handleDeploy()}
                        >
                            Deploy
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </Stack>
    );
}
