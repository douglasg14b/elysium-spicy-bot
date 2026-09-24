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
    Badge,
    Button,
    Center,
    Group,
    Loader,
    Menu,
    Modal,
    Stack,
    Switch,
    Text,
    TextInput,
    Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
    IconAlertTriangle,
    IconArrowBackUp,
    IconArrowForwardUp,
    IconChevronLeft,
    IconDeviceFloppy,
    IconChevronDown,
    IconCircleCheck,
    IconEye,
    IconPackageExport,
    IconPackageImport,
    IconRocket,
    IconStack2,
} from '@tabler/icons-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { getGuildChannels } from '../api/config';
import {
    deployFlow,
    getFlow,
    getGuildRoles,
    getInstallPlan,
    getNodeTypes,
    getPublishedState,
    installFlow,
    updateFlow,
} from '../api/flows';
// Only the initial read lives here now; the write moved into `useResourceAutosave`.
import {
    attachFlowToJourney,
    detachFlowFromJourney,
    getFlowAttachment,
    getFlowResources,
    listJourneys,
} from '../api/journeys';
import type {
    FlowAttachment,
    FlowEdge,
    FlowGraph,
    FlowValidationIssue,
    GuildChannel,
    GuildRole,
    InstallPlan,
    JourneySummary,
    NodeDescriptor,
    ResourceDeclaration,
} from '../api/types';
import { FLOW_GRAPH_VERSION } from '../api/types';
import { FlowNodeCard, type FlowCardNode, type FlowNodeCardData } from '../flows/FlowNodeCard';
// Aliased: `FlowEdge` is already taken here by the serialized-graph edge type from
// `../api/types`. The component draws one of those; it is not one.
import { FlowEdge as FlowEdgeComponent, EdgeActionsProvider } from '../flows/FlowEdge';
import { ColumnResizeHandle } from '../flows/ColumnResizeHandle';
import {
    INSPECTOR_DEFAULT_WIDTH,
    INSPECTOR_MAX_WIDTH,
    INSPECTOR_MIN_WIDTH,
    INSPECTOR_WIDTH_STORAGE_KEY,
    PALETTE_DEFAULT_WIDTH,
    PALETTE_MAX_WIDTH,
    PALETTE_MIN_WIDTH,
    PALETTE_WIDTH_STORAGE_KEY,
    clampWidth,
    readStoredWidth,
    type ResizeBounds,
} from '../flows/resizableColumn';
import { graphIncluding } from '../flows/graphHistory';
import {
    kindLabel,
    summariseInstallFailure,
    summariseInstallOutcome,
    summariseInstallPlan,
} from '../flows/installSummary';
import { InstalledResourcesDialog } from '../flows/InstalledResourcesDialog';
import { issuesByNode, summarizeIssues } from '../flows/validationIssues';
import { convergingTriggerCounts } from '../flows/convergingTriggers';
import { unreachableNodeIds } from '../flows/unreachableNodes';
import { actorAvailableAt, availableVariablesAt } from '../flows/variables';
import { NodePalette, NODE_DRAG_MIME } from '../flows/NodePalette';
import { NodeInspector } from '../flows/NodeInspector';
import { JourneyAttachmentControl } from '../flows/JourneyAttachmentControl';
import { INSTALL_QUERY_PARAM } from '../flows/installStateChip';
import { ResourcesDialog } from '../flows/ResourcesDialog';
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
            data: {
                ...node.data,
                config: structuredClone(node.data.config),
                // Zeroed rather than captured: this is derived from the last save's
                // response, not part of the graph, so restoring it would have undo
                // repaint cards red for a rejection that no longer describes them.
                // The effect that owns it puts the right number back.
                issueCount: 0,
                // **Carried**, unlike `issueCount` above, and the difference is the
                // point: a save verdict restored from a snapshot is stale, while
                // reachability is a property of the graph being restored. The effect
                // recomputes it either way, so zeroing here would only put one frame
                // of every card at full strength before they fade back.
                unreachable: node.data.unreachable,
                // Carried for the same reason, and it is a property of the restored
                // graph rather than a verdict about an older one.
                convergingTriggers: node.data.convergingTriggers,
            },
        })),
        edges: structuredClone(source.edges),
    };
}

/**
 * A column width that survives a reload.
 *
 * A workspace preference rather than per-flow state: the operator's screen and
 * their tolerance for a dense panel do not change when they open a different flow.
 * Read lazily so the parse happens once on mount rather than every render, and
 * clamped on the way in *and* out, because `localStorage` is a string an older
 * build may have written under different bounds.
 */
function useStoredWidth(
    storageKey: string,
    fallback: number,
    bounds: ResizeBounds
): [number, (width: number) => void] {
    const [width, setWidth] = useState(() =>
        readStoredWidth(
            typeof window === 'undefined' ? null : window.localStorage.getItem(storageKey),
            fallback,
            bounds
        )
    );

    const resize = useCallback(
        (next: number) => {
            const clamped = clampWidth(next, bounds);
            setWidth(clamped);
            window.localStorage.setItem(storageKey, String(clamped));
        },
        // `bounds` is an object literal at both call sites, so a new reference every
        // render — depending on it would rebuild this callback each time and, through
        // the handle's effect, tear down and re-register the drag listeners mid-drag.
        // The values behind it are module constants, so the identity is noise.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [storageKey, bounds.min, bounds.max]
    );

    return [width, resize];
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
    // Only for the flows list's `?install=1` hand-off; see the effect that consumes it.
    const [searchParams, setSearchParams] = useSearchParams();
    const { screenToFlowPosition } = useReactFlow();

    const [nodes, setNodes, onNodesChange] = useNodesState<FlowCardNode>([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

    const [nodeCatalog, setNodeCatalog] = useState<NodeDescriptor[]>([]);
    const [roles, setRoles] = useState<GuildRole[]>([]);
    const [channels, setChannels] = useState<GuildChannel[]>([]);
    /**
     * What this flow declares but has not installed.
     *
     * Saved on its own endpoint rather than with the graph: a declaration is what the
     * *guild* will get, and batching it into the graph save would mean a rejected
     * graph silently discarded the resource edits too.
     */
    const [declaredResources, setDeclaredResources] = useState<ResourceDeclaration[]>([]);
    // The saving flag and the save error moved into `ResourcesDialog` with the autosave
    // they describe. Nothing outside that modal ever read them, and keeping them here
    // would have been two pieces of state the page held on another component's behalf.
    const [showResources, setShowResources] = useState(false);
    /**
     * Which journey this flow installs, and every journey it could install instead.
     *
     * Read alongside the declarations rather than only when the panel opens, because the
     * two are one question: the resources below belong to *this* journey, and a flow
     * sharing one is editing declarations other flows install. `attachment` is `null`
     * for a flow attached to nothing, which is the normal state of most flows.
     */
    const [attachment, setAttachment] = useState<FlowAttachment | null>(null);
    const [guildJourneys, setGuildJourneys] = useState<JourneySummary[]>([]);
    const [attachmentLoading, setAttachmentLoading] = useState(true);

    const [inspectorWidth, resizeInspector] = useStoredWidth(
        INSPECTOR_WIDTH_STORAGE_KEY,
        INSPECTOR_DEFAULT_WIDTH,
        { min: INSPECTOR_MIN_WIDTH, max: INSPECTOR_MAX_WIDTH }
    );
    const [paletteWidth, resizePalette] = useStoredWidth(PALETTE_WIDTH_STORAGE_KEY, PALETTE_DEFAULT_WIDTH, {
        min: PALETTE_MIN_WIDTH,
        max: PALETTE_MAX_WIDTH,
    });

    const [name, setName] = useState('');
    const [enabled, setEnabled] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    /**
     * Why the last save was refused, kept until the next save answers.
     *
     * Not cleared on edit. An author fixing one of three problems would otherwise
     * watch the other two vanish with it, and have to save again to find out what
     * they were. They go stale instead — which is honest, because they describe the
     * graph as the server last saw it — and a save replaces the whole set.
     */
    const [saveIssues, setSaveIssues] = useState<readonly FlowValidationIssue[]>([]);

    const [deployOpen, setDeployOpen] = useState(false);
    const [deploying, setDeploying] = useState(false);

    /**
     * The install review step.
     *
     * `installPlan` is `null` while the plan is still being fetched, which is distinct
     * from a loaded plan with nothing to do — the dialog must not say "nothing to
     * install" before it has asked. `installPlanError` holds the server's refusal (a
     * flow declaring nothing, a journey owned by another flow), which is the answer
     * rather than a failure to get one.
     */
    const [installOpen, setInstallOpen] = useState(false);
    const [installPlan, setInstallPlan] = useState<InstallPlan | null>(null);
    const [installPlanError, setInstallPlanError] = useState<string | null>(null);
    const [installing, setInstalling] = useState(false);
    /** The second step: the plan has been read, and the operator is confirming it. */
    const [confirmInstall, setConfirmInstall] = useState(false);
    /**
     * Which plan request the dialog is currently waiting on. Bumped by every fetch and
     * by the effect cleanup that closes or unmounts the dialog, so an older one landing
     * late is discarded rather than shown — see `loadInstallPlan`.
     */
    const installPlanRequest = useRef(0);

    /**
     * Open the wizard when arrived at from the flows list's install button.
     *
     * The list has no install path of its own — the wizard reviews a plan the server
     * builds, and a second copy of that on the list would be a second answer to "what will
     * this do to my server". So the button navigates here with `?install=1`.
     *
     * **The parameter is stripped in the same effect**, with `replace` so no history entry
     * is spent on it. Left in the URL it would reopen the wizard on every refresh and on
     * every back-navigation to this flow, long after the operator dismissed it — a dialog
     * that cannot be got rid of without editing the address bar.
     */
    useEffect(() => {
        if (searchParams.get(INSTALL_QUERY_PARAM) !== '1') return;

        setInstallOpen(true);

        const next = new URLSearchParams(searchParams);
        next.delete(INSTALL_QUERY_PARAM);
        setSearchParams(next, { replace: true });
    }, [searchParams, setSearchParams]);

    /**
     * The inventory of what this flow already has in the guild, and the uninstall.
     *
     * Reachable from the builder because that is where the install lives: an operator
     * who can create channels from this toolbar should be able to take them back from
     * it, rather than having to leave for the flows list to find the only teardown.
     */
    const [installedOpen, setInstalledOpen] = useState(false);
    /**
     * How many resources this flow currently has live, or `null` before we have asked.
     *
     * Fetched on load rather than only when the dialog opens, because the toolbar
     * button's own face depends on it: a flow with nothing installed offers "Install",
     * and one with resources live offers to show and remove them. A button that cannot
     * tell those apart is the two-buttons-for-one-concept problem this replaced.
     *
     * `null` means unknown, which renders as the plain install affordance — the safe
     * default, since it proposes creating rather than destroying.
     */
    const [installedCount, setInstalledCount] = useState<number | null>(null);
    /**
     * Which declared resources are live, by key.
     *
     * Read from the same call as the count above rather than fetched separately, because it
     * is the same answer sliced differently. The resources panel needs it to know when a
     * key may stop following its name: once something in the guild is bound to a key, that
     * key is identity — `resource_bindings` rows and node config sidecars point at it — and
     * changing it would orphan both (`resourceKeyFollowsName.ts`).
     *
     * Empty while unknown, which narrows the rule to its hand-edit half rather than
     * freezing everything. Freezing on a failed lookup would be the safer-looking choice
     * and is the wrong one: it would silently reinstate the stale-key bug for any operator
     * whose published lookup happened to fail.
     */
    const [installedResourceKeys, setInstalledResourceKeys] = useState<ReadonlySet<string>>(
        () => new Set()
    );

    const refreshInstalledCount = useCallback(async () => {
        if (!selected || !flowId) return;
        try {
            const state = await getPublishedState(selected.id, flowId);
            setInstalledCount(state.deletableResources.length + state.refusedResources.length);
            // Both lists: a refused resource is still installed. `refused` is about whether
            // a *teardown* may touch it — an adopted channel, a category with survivors —
            // and an adopted resource is exactly the case where the key must not move, since
            // the binding points at someone else's channel.
            setInstalledResourceKeys(
                new Set(
                    [...state.deletableResources, ...state.refusedResources].map(
                        (resource) => resource.resourceKey
                    )
                )
            );
        } catch {
            // A failed lookup leaves the button on its install face rather than
            // guessing. The dialog does its own fetch and reports properly.
            setInstalledCount(null);
        }
    }, [selected, flowId]);

    useEffect(() => {
        void refreshInstalledCount();
    }, [refreshInstalledCount]);

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
                const [flow, catalog, guildRoles, guildChannels, flowResources] = await Promise.all([
                    getFlow(selected.id, flowId),
                    getNodeTypes(),
                    getGuildRoles(selected.id),
                    getGuildChannels(selected.id),
                    getFlowResources(selected.id, flowId),
                ]);
                if (cancelled) return;

                setNodeCatalog(catalog);
                setRoles(guildRoles);
                setChannels(guildChannels);
                setDeclaredResources(flowResources);
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
                                // A freshly loaded flow has not been saved in this
                                // session, so nothing has been refused yet.
                                issueCount: 0,
                                // The effect answers both as soon as the edges land.
                                unreachable: false,
                                convergingTriggers: 0,
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
                    // Nothing has judged it yet; the next save will.
                    issueCount: 0,
                    // A block just dropped from the palette has no edges, and an
                    // unwired node is deliberately never marked — see
                    // `unreachableNodeIds`. False is also what the effect will say.
                    unreachable: false,
                    // Nothing reaches a block with no edges, let alone two triggers.
                    convergingTriggers: 0,
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
    /**
     * Persist the declaration list on its own, rather than on the toolbar's Save.
     *
     * A declaration is about the *guild*, not the graph, and the pickers read it the
     * moment it changes — so deferring it to the toolbar would let an author pick a
     * resource the server does not yet know about.
     *
     * **The edit and its persistence are two events, and conflating them broke typing.**
     * This callback used to PUT on every keystroke. That disabled the field being typed
     * into (the browser blurs a focused element the moment it is disabled, which React
     * cannot undo), sent half-typed keys the server's schema refused, and then re-read
     * the stored list over the top — so a character vanished along with the cursor.
     *
     * Now the edit is local and immediate, and the save is a consequence of editing
     * having stopped. The ordering rules that keeps — which response may be applied, and
     * when a failure is allowed to revert the screen — are in `resourceSaveQueue.ts`,
     * where they can be tested; getting them wrong is how the revert half of that bug
     * would come back.
     */
    const saveResources = useCallback((next: ResourceDeclaration[]) => {
        setDeclaredResources(next);
    }, []);

    /**
     * Where the declarations are saved: this flow, journey resolved server-side.
     *
     * Memoised because it is the autosave's identity by way of `ResourcesDialog`, and a new
     * object every render would restart the debounce on each one — see the `targetRef` note
     * in `useResourceAutosave`. `flowId` is the route parameter, so it is stable across a
     * render and changes exactly when the builder moves to another flow.
     */
    const resourcesTarget = useMemo(
        () => (flowId ? ({ kind: 'flow', flowId } as const) : undefined),
        [flowId]
    );

    /**
     * Re-read which journey this flow installs, and what else it could.
     *
     * Both together, because attaching changes both answers: the flow's own journey
     * obviously, and every other journey's attached-flow list, which is what the picker
     * and the "shared with" line are built from. Re-fetching rather than patching means
     * a journey deleted or attached from the journeys page in another tab converges
     * here instead of leaving a picker offering something gone.
     */
    const refreshAttachment = useCallback(async () => {
        if (!selected || !flowId) return;
        setAttachmentLoading(true);
        try {
            const [current, all] = await Promise.all([
                getFlowAttachment(selected.id, flowId),
                listJourneys(selected.id),
            ]);
            setAttachment(current);
            setGuildJourneys(all);
        } catch {
            // Left as it was rather than cleared. Blanking the attachment on a failed
            // read would tell the operator this flow installs nothing, which is a
            // stronger claim than "we could not ask" and the one that invites them to
            // attach something on top of what is already there.
        } finally {
            setAttachmentLoading(false);
        }
    }, [selected, flowId]);

    useEffect(() => {
        void refreshAttachment();
    }, [refreshAttachment]);

    /**
     * Attach this flow to a journey, then reload what it declares.
     *
     * The resource list is re-read rather than kept, because it belongs to the journey
     * and the flow has just changed which journey that is. Keeping the old list would
     * leave the panel showing the previous journey's declarations — and the autosave
     * would then write them into the new one, which is the shape that silently
     * overwrites another flow's declarations.
     */
    const handleAttach = useCallback(
        async (journeyKey: string) => {
            if (!selected || !flowId) return;
            try {
                const result = await attachFlowToJourney(selected.id, flowId, journeyKey);
                setDeclaredResources(await getFlowResources(selected.id, flowId));
                await refreshAttachment();
                notifications.show({
                    color: 'brand',
                    title: result.movedFrom ? 'Moved' : 'Attached',
                    message: result.movedFrom
                        ? `This flow now installs "${result.name}" instead of "${result.movedFrom.name}".`
                        : `This flow now installs "${result.name}".`,
                });
            } catch (err) {
                const message =
                    err instanceof ApiError ? err.message : "Couldn't attach that journey.";
                notifications.show({ color: 'red', title: "Couldn't attach", message });
            }
        },
        [selected, flowId, refreshAttachment]
    );

    const handleDetach = useCallback(async () => {
        if (!selected || !flowId) return;
        try {
            await detachFlowFromJourney(selected.id, flowId);
            setDeclaredResources(await getFlowResources(selected.id, flowId));
            await refreshAttachment();
            notifications.show({
                color: 'brand',
                title: 'Detached',
                message:
                    'This flow no longer installs that journey. Anything already in your server stays put.',
            });
        } catch (err) {
            const message = err instanceof ApiError ? err.message : "Couldn't detach.";
            notifications.show({ color: 'red', title: "Couldn't detach", message });
        }
    }, [selected, flowId, refreshAttachment]);

    /**
     * Fetch what installing would do, server-side.
     *
     * Built there rather than derived here from `declaredResources`, because half of
     * what blocks an item is a fact about the guild — a name already taken, an adopted
     * id that stopped resolving, a permission model that cannot be satisfied. A plan
     * guessed in the browser would show an install that the apply then refuses.
     *
     * A refused plan (nothing declared, or a journey belonging to another flow) is the
     * answer to the question, so it lands in `installPlanError` and is shown, not
     * thrown away as a failed request.
     */
    const loadInstallPlan = useCallback(async () => {
        if (!selected || !flowId) return;
        /*
         * Two callers race: the open effect, and the 409 path in `handleInstall`. A
         * fetch that resolves after the dialog was closed — or after a reopen asked
         * again — would write a plan describing a guild the operator is no longer
         * looking at, which is the remembered plan the effect below exists to prevent.
         * Only the newest request may touch the state; the rest resolve into nothing.
         */
        installPlanRequest.current += 1;
        const request = installPlanRequest.current;
        const isCurrent = (): boolean => installPlanRequest.current === request;

        setInstallPlan(null);
        setInstallPlanError(null);
        try {
            const plan = await getInstallPlan(selected.id, flowId);
            if (isCurrent()) setInstallPlan(plan);
        } catch (cause) {
            if (!isCurrent()) return;
            setInstallPlanError(
                cause instanceof ApiError ? cause.message : 'Could not work out what to install.'
            );
        }
    }, [selected, flowId]);

    /*
     * Ask the moment the dialog opens, and forget it when it closes — a plan is a
     * statement about the guild a second ago, and showing a remembered one next time
     * would be showing an answer to a question nobody asked again.
     *
     * The cleanup retires whatever is inflight, so a fetch that lands after a close,
     * a reopen, or an unmount resolves into nothing rather than re-populating what was
     * just cleared. Clearing the state itself is `loadInstallPlan`'s job on the way in,
     * which keeps one writer for it.
     */
    useEffect(() => {
        if (!installOpen) {
            setInstallPlan(null);
            setInstallPlanError(null);
            setConfirmInstall(false);
            return;
        }
        void loadInstallPlan();
        return () => {
            installPlanRequest.current += 1;
        };
    }, [installOpen, loadInstallPlan]);

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
            setSaveIssues([]);
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
            // Replaced wholesale, including with an empty list: a failure carrying no
            // issues (a 500, a dropped connection) says nothing about which nodes are
            // wrong, and leaving the previous set up would attribute the last
            // rejection's blame to this one.
            const issues = err instanceof ApiError ? err.issues : [];
            setSaveIssues(issues);
            // Selecting the first errored node is the whole difference between a
            // sentence about a field and knowing which of a dozen blocks it is on.
            const firstBlamed = issues.find((issue) => issue.nodeId)?.nodeId;
            if (firstBlamed) setSelectedNodeId(firstBlamed);
            notifications.show({
                color: 'red',
                title: "That graph won't fly",
                message: issues.length > 0 ? summarizeIssues(issues) : message,
            });
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

    /**
     * Apply the plan the operator just reviewed.
     *
     * Sends no plan. The server rebuilds and re-checks its own, so a 409 here means the
     * guild drifted since the preview — the new plan comes back with it and replaces
     * what is on screen, putting the operator back on the review step rather than
     * leaving them looking at an approval that no longer holds.
     */
    async function handleInstall() {
        if (!selected || !flowId) return;
        setInstalling(true);
        try {
            const result = await installFlow(selected.id, flowId);
            const outcome = summariseInstallOutcome(result);
            notifications.show({
                color: outcome.tone,
                title: outcome.title,
                message: outcome.message,
            });
            setConfirmInstall(false);
            setInstallOpen(false);

            // Flips the toolbar to its installed face without a reload.
            void refreshInstalledCount();

            // The install wrote ids into this flow's nodes, so what is on screen is now
            // behind the server. Reloading would discard unsaved canvas edits, so the
            // author is told instead and reopens when they are ready.
            if (result.writtenCount > 0) {
                notifications.show({
                    color: 'brand',
                    title: 'Reopen to see the new ids',
                    message:
                        'Your blocks now point at the channels that were just created. Reload this flow to see them filled in.',
                });
            }
        } catch (err) {
            /*
             * Whether this touched the guild depends on the status, not on the error's
             * class: `ApiError` is thrown for every non-2xx, so a 500 or a proxy 504
             * arrives as one while channels may already exist. `summariseInstallFailure`
             * owns that rule and is tested against it.
             */
            const failure = summariseInstallFailure(
                err instanceof ApiError ? err.status : null,
                err instanceof ApiError ? err.message : "Couldn't install that."
            );
            notifications.show({
                color: failure.tone,
                title: failure.title,
                message: failure.message,
            });
            // A 409 is drift, and the server sends the rebuilt plan with it. Fetching
            // it again is the simplest way to show the operator what changed, and it
            // also covers the refusals that carry no plan at all.
            setConfirmInstall(false);
            void loadInstallPlan();
        } finally {
            setInstalling(false);
        }
    }

    async function handleDeploy() {
        if (!selected || !flowId) return;
        setDeploying(true);
        try {
            const { posted } = await deployFlow(selected.id, flowId);
            setDeployOpen(false);
            const buttons = posted.reduce((total, entry) => total + entry.buttonCount, 0);
            notifications.show({
                color: 'brand',
                title: 'Deployed',
                message:
                    posted.length === 1
                        ? `${buttons} button(s) live in that channel. Go press one.`
                        : `${buttons} buttons live across ${posted.length} channels. Go press one.`,
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

    const issuesForNode = useMemo(() => issuesByNode(saveIssues), [saveIssues]);

    /**
     * Which nodes no trigger reaches, recomputed on every edit.
     *
     * Computed here because this is the only component holding both the nodes and the
     * edges — the same reason `availableVariables` below is. Live rather than returned
     * by a save: a verdict from the server would describe the graph that was *saved*
     * and would be wrong the instant an author drags an edge, which is precisely the
     * work that fixes it.
     */
    const unreachableIds = useMemo(() => unreachableNodeIds(nodes, edges), [nodes, edges]);

    /**
     * Which nodes several triggers reach, and so run several times per event.
     *
     * The companion to the above, and computed here for the same reason. Every matching
     * trigger starts its own run — which is correct — so two converging on one action
     * is two runs through it. Worth saying because the canvas draws two edges into a
     * node and never mentions how many times it fires.
     */
    const convergingCounts = useMemo(() => convergingTriggerCounts(nodes, edges), [nodes, edges]);

    /**
     * Push each node's issue count and reachability onto its card data.
     *
     * React Flow renders from `node.data`, so a card cannot read page state — it has
     * to be carried. An effect rather than part of the save handler, so the count
     * also follows the nodes: `snapshot` deliberately zeroes `issueCount`, and undo
     * would otherwise leave every restored card clean until the next save.
     *
     * Deliberately **not** through `pushHistory`: a failed save is not a graph edit,
     * and recording one would let undo "restore" a graph that differs only in which
     * cards are red. Reachability is not an edit either — it is a *consequence* of one
     * that is already in history.
     *
     * Both facts ride one effect rather than two. They write the same nodes through the
     * same setter, and a second effect would compute its answer from whatever
     * intermediate state the first had just produced.
     *
     * `nodes` is a dependency *and* the thing being set, which is only safe because
     * the updater returns `prev` unchanged when every value already matches — the
     * second pass is referentially identical, so React stops there rather than
     * looping.
     */
    useEffect(() => {
        setNodes((prev) => {
            let changed = false;
            const next = prev.map((node) => {
                const count = issuesForNode.get(node.id)?.length ?? 0;
                const unreachable = unreachableIds.has(node.id);
                const convergingTriggers = convergingCounts.get(node.id) ?? 0;
                if (
                    node.data.issueCount === count &&
                    node.data.unreachable === unreachable &&
                    node.data.convergingTriggers === convergingTriggers
                ) {
                    return node;
                }
                changed = true;
                return {
                    ...node,
                    data: { ...node.data, issueCount: count, unreachable, convergingTriggers },
                };
            });
            return changed ? next : prev;
        });
    }, [issuesForNode, unreachableIds, convergingCounts, nodes, setNodes]);

    /**
     * What the selection's ancestry implies for the copy fields in it.
     *
     * Computed here because this is the only component holding both the nodes and
     * the edges; the inspector draws one node and has no way to walk a graph.
     *
     * Both facts in one memo rather than two with identical dependencies, so they
     * are recomputed together and cannot disagree about the graph they read. Each
     * still walks the ancestry itself; the walk is a small breadth-first pass over
     * one node's ancestors, and sharing it across the two would mean threading the
     * result through both signatures for a saving nobody has measured.
     *
     * Recomputed when any node's data changes rather than only on a rewire, which
     * is deliberate: renaming `action.pickRandom`'s output is a config edit, and a
     * list that did not follow it would offer the old name until the author
     * happened to move an edge.
     */
    const { availableVariables, actorAvailable } = useMemo(
        () => ({
            availableVariables: selectedNodeId
                ? availableVariablesAt(selectedNodeId, nodes, edges)
                : [],
            // True with nothing selected: no node means no copy field to advise.
            actorAvailable: selectedNodeId ? actorAvailableAt(selectedNodeId, nodes, edges) : true,
        }),
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

    // Every decision about what the install dialog says lives in `installSummary`,
    // which is a plain module and therefore testable — `web/` has no jsdom, so a
    // decision left inside JSX is a decision nothing can check.
    const planSummary = useMemo(
        () => (installPlan ? summariseInstallPlan(installPlan) : null),
        [installPlan]
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

                <Tooltip label="Channels and roles this flow needs but doesn’t have yet">
                    <Button
                        variant="light"
                        color="gray"
                        size="xs"
                        leftSection={<IconStack2 size={15} />}
                        onClick={() => setShowResources(true)}
                        rightSection={
                            declaredResources.length > 0 ? (
                                <Badge size="xs" circle variant="filled" color="brand">
                                    {declaredResources.length}
                                </Badge>
                            ) : undefined
                        }
                    >
                        Resources
                    </Button>
                </Tooltip>

                {/*
                 * One control, whose face follows the state.
                 *
                 * "Install" and "Installed" used to sit side by side — two buttons for
                 * one concept, where the second was an adjective and so read as a status
                 * label that happened to be clickable. Install and uninstall are not
                 * siblings; they are the two directions of one operation, and which one
                 * applies is a fact about the server, not a choice for the operator to
                 * work out.
                 *
                 * Nothing installed → the install affordance, and only when there is
                 * something declared to install. Anything installed → a menu whose
                 * destructive direction is named, coloured, and one deliberate click
                 * deeper, which is where a "delete real channels" action belongs.
                 */}
                {installedCount !== null && installedCount > 0 ? (
                    <Menu shadow="md" width={252} position="bottom-start">
                        <Menu.Target>
                            <Button
                                variant="light"
                                color="teal"
                                size="xs"
                                leftSection={<IconCircleCheck size={15} />}
                                rightSection={<IconChevronDown size={13} />}
                            >
                                Installed
                            </Button>
                        </Menu.Target>
                        <Menu.Dropdown>
                            <Menu.Item
                                leftSection={<IconEye size={14} />}
                                onClick={() => setInstalledOpen(true)}
                            >
                                See what’s in your server
                                <Text size="11px" c="dimmed">
                                    {installedCount} resource{installedCount === 1 ? '' : 's'}
                                </Text>
                            </Menu.Item>
                            {declaredResources.length > 0 && (
                                <Menu.Item
                                    leftSection={<IconPackageImport size={14} />}
                                    onClick={() => setInstallOpen(true)}
                                >
                                    Reinstall missing pieces
                                    <Text size="11px" c="dimmed">
                                        Rebuilds anything deleted by hand
                                    </Text>
                                </Menu.Item>
                            )}
                            <Menu.Divider />
                            {/*
                             * Opens the inventory rather than deleting on the spot. The
                             * confirmation is the list plus the counted button inside —
                             * a menu item must never be the last step before destroying
                             * real channels.
                             */}
                            <Menu.Item
                                color="red"
                                leftSection={<IconPackageExport size={14} />}
                                onClick={() => setInstalledOpen(true)}
                            >
                                Uninstall from server
                                <Text size="11px" c="dimmed">
                                    Deletes what this flow created
                                </Text>
                            </Menu.Item>
                        </Menu.Dropdown>
                    </Menu>
                ) : (
                    /*
                     * Offered only when the flow declares something. An install button on
                     * a flow with no declarations has nothing to do and would send the
                     * operator to a dialog whose only content is the 404 explaining that.
                     */
                    declaredResources.length > 0 && (
                        <Tooltip label="Create the channels and roles this flow needs">
                            <Button
                                variant="light"
                                color="gray"
                                size="xs"
                                leftSection={<IconPackageImport size={15} />}
                                onClick={() => setInstallOpen(true)}
                            >
                                Install {declaredResources.length}
                            </Button>
                        </Tooltip>
                    )
                )}

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
                        width: paletteWidth,
                        flexShrink: 0,
                        background: 'var(--mantine-color-dark-8)',
                        overflow: 'hidden',
                    }}
                >
                    <NodePalette nodeTypes={nodeCatalog} onAdd={(entry) => addNode(entry)} />
                </div>

                <ColumnResizeHandle
                    width={paletteWidth}
                    onResize={resizePalette}
                    bounds={{ min: PALETTE_MIN_WIDTH, max: PALETTE_MAX_WIDTH }}
                    anchor="left"
                    label="Palette width"
                />

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

                <ColumnResizeHandle
                    width={inspectorWidth}
                    onResize={resizeInspector}
                    label="Inspector width"
                />

                <div
                    style={{
                        width: inspectorWidth,
                        flexShrink: 0,
                        background: 'var(--mantine-color-dark-8)',
                        overflow: 'hidden',
                    }}
                >
                    {/*
                     * The right column is the selected node's configuration and
                     * nothing else. Resources used to share it behind a tab toggle,
                     * which meant clicking a block while that tab was open showed no
                     * block details at all — a flow-wide concern occupying a
                     * per-node space. It is a toolbar modal now.
                     */}
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
                            actorAvailable={actorAvailable}
                            declaredResources={declaredResources}
                            issues={issuesForNode.get(selectedNode.id) ?? []}
                            onChange={updateNodeConfig}
                            onDelete={deleteSelectedNode}
                        />
                    ) : (
                        <Stack align="center" justify="center" h="100%" gap={6} px="lg">
                            <Text fw={700} size="14px">
                                Nothing selected
                            </Text>
                            <Text size="12.5px" c="dimmed" ta="center">
                                Drag a node from the left, then click it to configure. The
                                canvas won&apos;t bite.
                            </Text>
                        </Stack>
                    )}
                </div>
            </Group>

            {/*
             * Generously sized: a resource row holds a name, a key, an "already
             * exists" picker, a parent and a list of permission rules, and each rule
             * is an audience plus an access level plus possibly a role list. That does
             * not fit a narrow column, which is half of why the panel was unusable
             * where it was — and `xl` was still cramped enough to read as a sidebar.
             *
             * An explicit width rather than a `size` token because the token ladder
             * stops short of what a row needs. The height keeps a list of several
             * resources out of a short scroll well, which was the other half of the
             * complaint.
             */}
            {/*
             * The shell, the sizing, the autosave and the guild directory all live in
             * `ResourcesDialog` now, so the flows page's group header can open the same
             * editor. What stays here is the two things only the builder has: the journey
             * it saves against, and the attachment control above the list.
             */}
            {selected && resourcesTarget && (
                <ResourcesDialog
                    opened={showResources}
                    onClose={() => setShowResources(false)}
                    guildId={selected.id}
                    target={resourcesTarget}
                    title="Resources this flow needs"
                    /*
                     * Above the list, not beside it: the control answers "whose resources
                     * are these?", and the whole list below is meaningless without it. A
                     * flow on a shared journey is editing declarations other flows install.
                     */
                    header={
                        <JourneyAttachmentControl
                            attachment={attachment}
                            journeys={guildJourneys}
                            loading={attachmentLoading}
                            onAttach={handleAttach}
                            onDetach={handleDetach}
                        />
                    }
                    installedKeys={installedResourceKeys}
                    resources={declaredResources}
                    onChange={saveResources}
                    journeyKey={attachment?.journeyKey}
                    loaded={!loading && !attachmentLoading}
                    onSaved={setDeclaredResources}
                />
            )}

            {/*
             * Review, then apply. Two steps rather than one button, because this
             * creates real channels and roles in a live server — the same shape the
             * teardown confirm uses, for the same reason.
             */}
            <Modal
                opened={installOpen}
                onClose={() => setInstallOpen(false)}
                title="Install what this flow needs"
                size="lg"
            >
                <Stack gap="md">
                    {installPlanError ? (
                        <Alert color="orange" icon={<IconAlertTriangle size={16} />}>
                            <Text size="13px">{installPlanError}</Text>
                        </Alert>
                    ) : !planSummary ? (
                        <Center py="xl">
                            <Loader color="brand" size="sm" />
                        </Center>
                    ) : (
                        <>
                            {planSummary.headline && (
                                <Text size="13.5px">{planSummary.headline}</Text>
                            )}

                            {planSummary.changes.length > 0 && (
                                <Stack gap={4}>
                                    {planSummary.changes.map((item) => (
                                        <Text key={item.resourceKey} size="12.5px">
                                            <Text span c={item.action === 'adopt' ? 'yellow.5' : 'brand.4'} fw={600}>
                                                {item.action === 'adopt' ? 'Adopt' : 'Create'}
                                            </Text>{' '}
                                            {kindLabel(item.kind)}{' '}
                                            <Text span fw={600}>
                                                {item.name}
                                            </Text>
                                            {item.reason && (
                                                <Text size="12px" c="dimmed">
                                                    {item.reason}
                                                </Text>
                                            )}
                                        </Text>
                                    ))}
                                </Stack>
                            )}

                            {/*
                             * The already-bound ones are listed too. "What will this do
                             * to my server" is only answerable if the things it will
                             * leave alone are visible as well.
                             */}
                            {planSummary.unchanged.length > 0 && (
                                <Text size="12px" c="dimmed">
                                    Already in place, and staying that way:{' '}
                                    {planSummary.unchanged.map((item) => item.name).join(', ')}.
                                </Text>
                            )}

                            {planSummary.problems.length > 0 && (
                                <Alert
                                    color="orange"
                                    icon={<IconAlertTriangle size={16} />}
                                    title="Sort these out first"
                                >
                                    <Stack gap={4}>
                                        {planSummary.problems.map((problem, index) => (
                                            <Text key={index} size="12.5px">
                                                • {problem}
                                            </Text>
                                        ))}
                                    </Stack>
                                </Alert>
                            )}

                            {!planSummary.headline && planSummary.problems.length === 0 && (
                                <Text size="13px" c="dimmed">
                                    Everything this flow declares is already in your server. Nothing
                                    to do.
                                </Text>
                            )}

                            <Group justify="flex-end" gap="sm">
                                <Button
                                    variant="subtle"
                                    color="gray"
                                    onClick={() => setInstallOpen(false)}
                                    disabled={installing}
                                >
                                    {planSummary.canApply ? 'Not now' : 'Close'}
                                </Button>
                                {planSummary.canApply &&
                                    (confirmInstall ? (
                                        <Button
                                            color="brand"
                                            loading={installing}
                                            onClick={() => void handleInstall()}
                                        >
                                            Yes, build it
                                        </Button>
                                    ) : (
                                        <Button
                                            color="brand"
                                            onClick={() => setConfirmInstall(true)}
                                        >
                                            Install
                                        </Button>
                                    ))}
                            </Group>
                        </>
                    )}
                </Stack>
            </Modal>

            {/*
             * The counterpart to Install, and the same dialog the flows list uses.
             *
             * No reload on `onChanged`, for the reason `handleInstall` does not reload
             * either: it would discard unsaved canvas edits. An uninstall leaves the
             * blocks pointing at ids that no longer exist, so the author is told and
             * reopens when they are ready — the same bargain, struck the same way.
             */}
            {selected && flowId && (
                <InstalledResourcesDialog
                    opened={installedOpen}
                    onClose={() => setInstalledOpen(false)}
                    guildId={selected.id}
                    flowId={flowId}
                    flowName={name || 'this flow'}
                    onChanged={(action) => {
                        // The toolbar button's face is derived from this count, so a
                        // teardown has to move it or the button keeps claiming the flow
                        // is installed after its channels are gone.
                        void refreshInstalledCount();

                        // Only an unpublish invalidates the canvas. An undeploy retires
                        // messages and leaves every bound id exactly as it was.
                        if (action !== 'unpublish') return;
                        notifications.show({
                            color: 'brand',
                            title: 'Your blocks still name what was deleted',
                            message:
                                'Any block pointing at something that just went is now pointing at nothing. Reinstall to rebuild it, or repoint those blocks yourself.',
                        });
                    }}
                />
            )}

            <Modal
                opened={deployOpen}
                onClose={() => setDeployOpen(false)}
                title="Deploy flow"
                size="sm"
            >
                <Stack gap="md">
                    <Text size="13px" c="dimmed">
                        Posts each button trigger into the channel it names, one message per
                        channel. Members click, the flow runs. Deploying again replaces whatever
                        this flow already has out there.
                    </Text>
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
