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
    type EdgeTypes,
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
import { FLOW_GRAPH_VERSION } from '../api/types';
import { FlowNodeCard, type FlowCardNode, type FlowNodeCardData } from '../flows/FlowNodeCard';
// Aliased: `FlowEdge` is already taken here by the serialized-graph edge type from
// `../api/types`. The component draws one of those; it is not one.
import { FlowEdge as FlowEdgeComponent, EdgeActionsProvider } from '../flows/FlowEdge';
import { graphIncluding } from '../flows/graphHistory';
import { availableVariablesAt } from '../flows/variables';
import { NodePalette, NODE_DRAG_MIME } from '../flows/NodePalette';
import { NodeInspector } from '../flows/NodeInspector';
import {
    defaultDataFor,
    EDGE_STROKE_WIDTH,
    emptyGraph,
    handlesAreLabelled,
    HANDLE_TONE_HEX,
    KIND_STYLES,
} from '../flows/nodeMeta';
import { useGuilds } from '../guilds/GuildContext';

const nodeTypes: NodeTypes = { flowCard: FlowNodeCard };
const edgeTypes: EdgeTypes = { flowEdge: FlowEdgeComponent };

/**
 * The edge type every connection is drawn with.
 *
 * Named rather than inlined because it has to agree in three places — the
 * registration above, `styleEdge`, and `defaultEdgeOptions` — and a connection that
 * names a type React Flow has not been given renders as nothing at all.
 */
const FLOW_EDGE_TYPE = 'flowEdge';

/** How many graph snapshots the undo stack keeps before dropping the oldest. */
const HISTORY_LIMIT = 50;

/**
 * Edge styling: an edge inherits the colour and label of the handle it leaves by.
 *
 * Resolved off the source block's declared `handles` rather than off magic handle
 * ids, so a condition declaring `pass`/`fail` — or any future tone — draws correctly
 * without editing this page. Labelled on the same shared rule the card uses.
 */
function styleEdge(edge: Edge, sourceDescriptor: NodeDescriptor | undefined): Edge {
    const handles = sourceDescriptor?.handles ?? [];
    const handle = handles.find((candidate) => (candidate.id ?? null) === (edge.sourceHandle ?? null));
    const stroke = handle ? HANDLE_TONE_HEX[handle.tone] : HANDLE_TONE_HEX.neutral;
    const label = handle && handlesAreLabelled(handles) ? handle.label : undefined;

    return {
        ...edge,
        type: FLOW_EDGE_TYPE,
        animated: true,
        style: { stroke, strokeWidth: EDGE_STROKE_WIDTH },
        label,
        // CSS, not SVG `fill`: `FlowEdge` draws the label into an HTML div via
        // `EdgeLabelRenderer`. These used to say `fill`, which was right for React
        // Flow's built-in SVG `<text>`/`<rect>` label and silently does nothing on
        // a div — the branch labels kept their text but lost their tone colour and
        // their backing plate against the canvas. Nothing renders these into SVG
        // any more, so there is one vocabulary here rather than a translation.
        labelStyle: { color: stroke, fontSize: 10, fontWeight: 700 },
        labelBgStyle: { background: '#1a1b23' },
    };
}

/** A graph snapshot for the undo stack. */
interface Snapshot {
    nodes: FlowCardNode[];
    edges: Edge[];
}

/**
 * Clone a graph for the undo stack, deep-copying only what can actually change.
 *
 * `config` is the mutable part and is cloned. `descriptor`, `roles` and `channels`
 * are shared immutable catalogue data riding along on each node: deep-cloning them
 * would copy every block's full manifest once per node per snapshot, fifty deep, and
 * would break referential identity with the live catalogue for no benefit.
 */
function snapshot(source: Snapshot): Snapshot {
    return {
        nodes: source.nodes.map((node) => ({
            ...node,
            position: { ...node.position },
            data: { ...node.data, config: structuredClone(node.data.config) },
        })),
        edges: structuredClone(source.edges),
    };
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

    /**
     * Push the current graph onto the undo stack before a mutating change.
     *
     * `removed` is for the one case that cannot follow that order: React Flow owns
     * Delete/Backspace, so it removes the elements and only then tells us. Passing
     * them here puts them back into the snapshot, which describes the prior graph
     * correctly however the effect flush happened to fall. Every other caller
     * mutates afterwards and passes nothing.
     */
    const pushHistory = useCallback(
        (removed: { nodes?: readonly FlowCardNode[]; edges?: readonly Edge[] } = {}) => {
            if (skipHistory.current) return;
            past.current.push(snapshot(graphIncluding(latest.current, removed)));
            if (past.current.length > HISTORY_LIMIT) past.current.shift();
            future.current = [];
            setHistoryTick((tick) => tick + 1);
            setDirty(true);
        },
        []
    );

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

                skipHistory.current = true;
                setNodes(
                    graph.nodes.map((node) => {
                        // Absent when a saved graph names a type this build has no
                        // block for; the card and inspector render that as broken.
                        const descriptor = catalog.find((entry) => entry.type === node.type);
                        return {
                            id: node.id,
                            type: 'flowCard' as const,
                            position: node.position,
                            data: {
                                nodeType: node.type,
                                label: descriptor?.label ?? node.type,
                                /*
                                 * Backfill any field whose default was declared after
                                 * this graph was written, so a control never displays
                                 * a value the graph does not actually contain. Done
                                 * here, once, inside the `skipHistory` window — a
                                 * control that repaired itself while rendering would
                                 * dirty the flow and clear the redo stack just for
                                 * selecting a node. Stored values always win.
                                 *
                                 * This leaves the in-memory graph ahead of the saved
                                 * one while the toolbar still reads "All changes
                                 * saved", which is deliberate: every value added here
                                 * is one the server's own schema would have defaulted
                                 * to anyway, so there is nothing worth prompting a
                                 * save for until the author actually edits something.
                                 */
                                config: descriptor
                                    ? { ...defaultDataFor(descriptor), ...(node.data ?? {}) }
                                    : node.data ?? {},
                                descriptor,
                                roles: guildRoles,
                                channels: guildChannels,
                            } satisfies FlowNodeCardData,
                        };
                    })
                );
                setEdges(
                    graph.edges.map((edge) => {
                        const sourceType = graph.nodes.find((node) => node.id === edge.source)?.type;
                        return styleEdge(
                            {
                                id: edge.id,
                                source: edge.source,
                                target: edge.target,
                                sourceHandle: edge.sourceHandle ?? null,
                                targetHandle: edge.targetHandle ?? null,
                            },
                            catalog.find((entry) => entry.type === sourceType)
                        );
                    })
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
                    config: defaultDataFor(entry),
                    descriptor: entry,
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
            const sourceDescriptor = latest.current.nodes.find(
                (node) => node.id === connection.source
            )?.data.descriptor;
            setEdges((prev) => addEdge(styleEdge({ ...connection, id }, sourceDescriptor), prev));
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
            const entry = nodeCatalog.find((candidate) => candidate.type === type);
            if (!entry) {
                // The drag came from our own palette, so a type we cannot find means
                // the catalog moved underneath this page. Say so rather than
                // swallowing the drop and looking broken.
                notifications.show({
                    color: 'red',
                    title: 'Unknown block',
                    message: `"${type}" isn't in this build. Reload the page and try again.`,
                });
                return;
            }
            const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
            addNode(entry, position);
        },
        [nodeCatalog, screenToFlowPosition, addNode]
    );

    /**
     * Live-edit the selected node's engine `data`.
     *
     * A patch entry of `undefined` **removes** the key, which is the contract the
     * controls are written against — an `optional` duration says "unset" that way.
     * Spreading alone would leave the key present holding `undefined`, which only
     * looks equivalent: `JSON.stringify` drops it on save, so an in-session graph
     * and the same graph after a reload would disagree the moment a field declared
     * both `optional` and a `defaultValue`, because the load-path backfill would
     * re-seed the default over a key that had genuinely been cleared.
     */
    const updateNodeConfig = useCallback(
        (patch: Record<string, unknown>) => {
            if (!selectedNodeId) return;
            pushHistory();
            setNodes((prev) =>
                prev.map((node) => {
                    if (node.id !== selectedNodeId) return node;
                    const config = { ...node.data.config, ...patch };
                    for (const [key, value] of Object.entries(patch)) {
                        if (value === undefined) delete config[key];
                    }
                    return { ...node, data: { ...node.data, config } };
                })
            );
        },
        [selectedNodeId, pushHistory, setNodes]
    );

    /**
     * Remove one connection, leaving both blocks and their configuration alone.
     *
     * Called by the ✕ on the edge, which is the only route that can push history
     * *before* mutating. React Flow's own Backspace route does not come through
     * here — it removes the elements first and notifies afterwards, so `onDelete`
     * has to reconstruct the prior graph instead.
     */
    const deleteEdge = useCallback(
        (edgeId: string) => {
            pushHistory();
            setEdges((prev) => prev.filter((edge) => edge.id !== edgeId));
        },
        [pushHistory, setEdges]
    );

    /**
     * Stable identity for the context the edges read their actions from.
     *
     * A fresh object here would re-render every edge on every keystroke elsewhere
     * on the page, which on a large graph is visible as lag while typing in the
     * inspector.
     */
    const edgeActions = useMemo(() => ({ onDelete: deleteEdge }), [deleteEdge]);

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
        (target: Snapshot) => {
            skipHistory.current = true;
            setNodes(target.nodes);
            setEdges(target.edges);
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
        future.current.push(snapshot(latest.current));
        restore(previous);
        setHistoryTick((t) => t + 1);
    }, [restore]);

    const redo = useCallback(() => {
        const next = future.current.pop();
        if (!next) return;
        past.current.push(snapshot(latest.current));
        restore(next);
        setHistoryTick((t) => t + 1);
    }, [restore]);

    /* ------------------------------ save ------------------------------ */

    const serialize = useCallback((): FlowGraph => {
        const liveIds = new Set(nodes.map((n) => n.id));
        return {
            version: FLOW_GRAPH_VERSION,
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

    /**
     * Variables some block upstream of the selection writes.
     *
     * Computed here because this is the only component holding both the nodes and
     * the edges; the inspector draws one node and has no way to walk a graph.
     *
     * Recomputed when any node's data changes rather than only on a rewire, which
     * is deliberate: renaming `action.pickRandom`'s output is a config edit, and a
     * list that did not follow it would offer the old name until the author
     * happened to move an edge.
     */
    const availableVariables = useMemo(
        () => (selectedNodeId ? availableVariablesAt(selectedNodeId, nodes, edges) : []),
        [selectedNodeId, nodes, edges]
    );

    /**
     * Deploy only makes sense when there's a button to post — that is, when some
     * node's block declares it is started by a button click. Asked of the descriptor
     * rather than of a type string, so a second button-shaped trigger would enable
     * Deploy without editing this page.
     */
    const hasButtonTrigger = useMemo(
        () => nodes.some((node) => node.data.descriptor?.startedBy === 'buttonClick'),
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

                {/*
                 * Wraps the canvas rather than sitting inside it: the edges React
                 * Flow renders read their delete handler from here, and the context
                 * travels down the React tree, so it does not matter that the ✕ is
                 * portalled into a different part of the DOM.
                 */}
                <EdgeActionsProvider value={edgeActions}>
                <div style={{ flex: 1, minWidth: 0, background: '#16171d' }} onDrop={onDrop} onDragOver={onDragOver}>
                    <ReactFlow<FlowCardNode, Edge>
                        nodes={nodes}
                        edges={edges}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onConnect={onConnect}
                        nodeTypes={nodeTypes}
                        edgeTypes={edgeTypes}
                        onNodeClick={(_, node) => setSelectedNodeId(node.id)}
                        onPaneClick={() => setSelectedNodeId(null)}
                        onNodeDragStart={() => pushHistory()}
                        /*
                         * React Flow's own Backspace route comes through here.
                         * It used to only `setDirty(true)`, which left the top of the
                         * undo stack describing a graph that no longer existed — so
                         * the next undo put the deleted thing back *and* re-applied a
                         * stale version of everything else.
                         *
                         * `onDelete` rather than the `onNodesDelete`/`onEdgesDelete`
                         * pair: deleting a node takes its connections with it, and
                         * React Flow fires *both* of those in the same gesture. One
                         * keypress would push two snapshots, so the first undo would
                         * work and the second would silently do nothing while eating
                         * a history step. `onDelete` fires once, with both lists.
                         *
                         * It is handed the elements being removed rather than reading
                         * current state, because by the time a handler runs React
                         * Flow has already decided they are gone; whether
                         * `latest.current` has caught up depends on effect-flush
                         * timing we should not be betting the undo stack on.
                         *
                         * The ✕ on an edge does not reach here — it calls
                         * `deleteEdge`, which pushes before mutating.
                         */
                        onDelete={({ nodes: removedNodes, edges: removedEdges }) =>
                            pushHistory({ nodes: removedNodes, edges: removedEdges })
                        }
                        fitView
                        proOptions={{ hideAttribution: true }}
                        defaultEdgeOptions={{ animated: true, type: FLOW_EDGE_TYPE }}
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
                                const { descriptor } = node.data as FlowNodeCardData;
                                // An unknown block has no kind to colour by; red
                                // matches how its card reads on the canvas.
                                return descriptor
                                    ? KIND_STYLES[descriptor.kind].miniMapColor
                                    : '#ed4245';
                            }}
                        />
                    </ReactFlow>
                </div>
                </EdgeActionsProvider>

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
                            descriptor={selectedNode.data.descriptor}
                            nodeType={selectedNode.data.nodeType}
                            label={selectedNode.data.label}
                            config={selectedNode.data.config}
                            roles={roles}
                            channels={channels}
                            variables={availableVariables}
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
