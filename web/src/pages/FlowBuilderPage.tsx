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
    useMantineTheme,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
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
    discardFlowDraft,
    getFlow,
    getGuildRoles,
    getInstallPlan,
    getNodeTypes,
    getPublishedState,
    installFlow,
    listFlowDrafts,
    saveMyFlowDraft,
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
    FlowDraft,
    FlowEdge,
    FlowGraph,
    GuildChannel,
    GuildRole,
    InstallPlan,
    JourneySummary,
    NodeDescriptor,
    ResourceDeclaration,
    TicketTypeView,
} from '../api/types';
import { FLOW_GRAPH_VERSION } from '../api/types';
import { getTicketsConfig } from '../api/tickets';
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
import { changedConfigKeys, graphIncluding } from '../flows/graphHistory';
import {
    builderStatusLine,
    draftLabel,
    draftOnlySaveMessage,
    formatWhen,
    orderDraftsForPicker,
    type BuilderStatus,
    type FlowDraftPayload,
} from '../flows/flowDraftAutosave';
import { useFlowDraftAutosave } from '../flows/useFlowDraftAutosave';
import { useFlowIssues } from '../flows/useFlowIssues';
import { LeaveFlowDialog, type LeaveAction } from '../flows/LeaveFlowDialog';
import { useLeaveGuard } from '../flows/useLeaveGuard';
import {
    changeLabel,
    kindLabel,
    summariseInstallFailure,
    summariseInstallOutcome,
    summariseInstallPlan,
} from '../flows/installSummary';
import { InstalledResourcesDialog } from '../flows/InstalledResourcesDialog';
import { issuesByNode, problemCount, summarizeIssues } from '../flows/validationIssues';
import { convergingTriggerCounts } from '../flows/convergingTriggers';
import { unreachableNodeIds } from '../flows/unreachableNodes';
import { exitWarningsShown, unconnectedWarnedExits } from '../flows/unconnectedExits';
import {
    ALL_REQUIREMENTS_AVAILABLE,
    availableVariablesAt,
    flowRunsAboutNobody,
    requirementsAvailableAt,
} from '../flows/variables';
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

/** A card with no forgotten exits, shared so the ordinary case allocates nothing. */
const NO_EXITS: readonly string[] = [];

/** The status line's colour per tone — yellow for unsaved, orange for "look at this". */
const STATUS_TONE_COLOUR: Record<BuilderStatus['tone'], string> = {
    clean: 'dark.2',
    dirty: 'yellow.5',
    attention: 'orange.5',
};

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
 * `config` is the mutable part and is cloned. `descriptor`, `roles`, `channels` and
 * `ticketTypes` are shared immutable catalogue data riding along on each node: deep-cloning them
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
                unconnectedExits: node.data.unconnectedExits,
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
    const theme = useMantineTheme();
    const navigate = useNavigate();
    /*
     * Below `md` the palette and inspector, plus the navbar from `sm` up, leave the canvas
     * nothing and the page scrolls sideways. The builder is desktop-first by decision, so
     * a phone or a portrait tablet is told so rather than handed a page it cannot use.
     * Read on the first render, not in an effect, so a phone never mounts the canvas.
     */
    const tooNarrow = useMediaQuery(`(max-width: calc(${theme.breakpoints.md} - 1px))`, false, {
        getInitialValueInEffect: false,
    });

    if (tooNarrow) {
        return (
            <Stack gap="md" maw={480}>
                <Alert color="gray" title="The builder needs more room">
                    A flow is built on a canvas with the palette on one side and the inspector on the other, and this
                    screen can&apos;t fit all three. Open this one on something wider.
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
    /** The guild's own declared ticket types, for the ticket-type picker and the cards. */
    const [ticketTypes, setTicketTypes] = useState<TicketTypeView[]>([]);
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
    /**
     * Leaving with the canvas not the saved flow asks first — even when the autosave has
     * the draft, because a draft is insurance and not the operator's answer. A draft-only
     * save clears `dirty`, so that one does not ask. See `shouldConfirmLeave`.
     */
    const leaveGuard = useLeaveGuard(dirty);
    /** The leave prompt's answer being carried out, if one is. */
    const [leaving, setLeaving] = useState<LeaveAction | null>(null);
    /*
     * Leaving while the toolbar's Save is still on its way. The prompt's answers wait for
     * it (see `pending` on the dialog) — each would race the save for the draft — and if it
     * lands there is nothing left unsaved to ask about, so the navigation goes through.
     * Only when no answer is running: an answer lets the navigation go itself.
     */
    useEffect(() => {
        if (leaveGuard.prompting && !dirty && !saving && leaving === null) leaveGuard.leave();
    }, [leaveGuard.prompting, leaveGuard.leave, dirty, saving, leaving]);
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    /**
     * How many problems the **stored** graph has — what decides whether it may be
     * switched on.
     *
     * Separate from `graphIssues` (below) because the two part company on a refused save: those
     * issues describe the graph the author just tried to send, while the stored one is
     * untouched. A structurally broken save of a flow whose stored graph is ready would
     * otherwise lock the switch on a graph the server never received.
     */
    const [storedIssueCount, setStoredIssueCount] = useState(0);
    /**
     * What the last save kept, when it landed on the operator's draft and not the flow:
     * the flow is live and the graph was incomplete. The canvas is persisted — so not
     * dirty — but it is not what members get, and the status line and the switch must not
     * pretend otherwise. The payload rather than a flag, because "discard changes" from the
     * leave prompt goes back to it: it was saved, so it is not one of the changes.
     */
    const [draftOnlySave, setDraftOnlySave] = useState<FlowDraftPayload | null>(null);
    const savedAsDraftOnly = draftOnlySave !== null;
    /** When the flow itself was last saved, for the picker's "Saved version" row. */
    const [savedVersionAt, setSavedVersionAt] = useState<string | null>(null);
    /**
     * The flow version the canvas descends from: the flow's `updatedAt` when it was
     * loaded or last saved here, or the base of a draft loaded from the picker. Every
     * draft written from this canvas records it, which is what lets the picker say "flow
     * saved since" about a save this page never saw.
     */
    const [canvasBase, setCanvasBase] = useState<string | null>(null);
    /**
     * Every operator's draft of this flow, as read on open. The picker lists them; nothing
     * else reads this, so it is not kept in step with the autosave afterwards.
     */
    const [drafts, setDrafts] = useState<FlowDraft[]>([]);
    const [draftPickerOpen, setDraftPickerOpen] = useState(false);

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

    /** The canvas as the engine's `FlowGraph` — what a save sends, and what a draft holds. */
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

    /** What Save sends, and what the autosave keeps as this operator's draft. */
    const canvasPayload = useMemo<FlowDraftPayload>(
        () => ({ name: name.trim() || 'Untitled flow', graph: serialize() }),
        [name, serialize]
    );

    /**
     * What is wrong with the canvas — on the cards and under the inspector's fields: the
     * server's last answer, with fields edited since checked live as the author types.
     * The server is re-asked as focus leaves the inspector. Never touches
     * `storedIssueCount`, which is about the stored graph and only an open or a save may
     * move.
     */
    const {
        issues: graphIssues,
        setIssues: setGraphIssues,
        editMark: graphEditMark,
        markEdited: markGraphEdited,
        recheck: recheckGraphIssues,
        recheckAfterStructuralEdit: recheckGraphShape,
    } = useFlowIssues({ guildId: selected?.id, flowId, graph: canvasPayload.graph, catalog: nodeCatalog });

    /**
     * Unsaved work, kept on the server as this operator's draft while they edit — so
     * leaving the page, or losing the tab, costs a couple of seconds rather than the
     * afternoon. Held while a save is in flight; the save decides what the draft holds.
     * Held too while a leave-prompt answer runs, which decides it the same way.
     */
    const draftAutosave = useFlowDraftAutosave({
        guildId: selected?.id,
        flowId,
        payload: canvasPayload,
        baseUpdatedAt: canvasBase ?? undefined,
        paused: saving || leaving !== null,
    });
    const { rebase: rebaseDraft } = draftAutosave;

    /**
     * Put a graph on the canvas as a fresh start: nodes backfilled and styled, edges
     * coloured, history emptied. Shared by the load and by the draft picker, so a draft
     * lands on the canvas exactly as the saved flow would have.
     *
     * The catalogue and guild directory are passed in rather than read from state,
     * because the load calls this in the same breath as it sets them.
     */
    const putGraphOnCanvas = useCallback(
        (
            graph: FlowGraph,
            directory: {
                readonly catalog: NodeDescriptor[];
                readonly roles: GuildRole[];
                readonly channels: GuildChannel[];
                readonly ticketTypes: TicketTypeView[];
            }
        ) => {
            const { catalog } = directory;
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
                             * The draft autosave agrees: its baseline is taken
                             * after this backfill, so it is not an edit to it either.
                             */
                            config: descriptor
                                ? { ...defaultDataFor(descriptor), ...(node.data ?? {}) }
                                : node.data ?? {},
                            descriptor,
                            roles: directory.roles,
                            channels: directory.channels,
                            ticketTypes: directory.ticketTypes,
                            // Filled from the flow's own `issues` by the effect
                            // that carries `graphIssues` onto the cards.
                            issueCount: 0,
                            // The effect answers both as soon as the edges land.
                            unreachable: false,
                            convergingTriggers: 0,
                            unconnectedExits: [],
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
            setHistoryTick((t) => t + 1);
            // Let the state flush before re-arming history capture.
            requestAnimationFrame(() => {
                skipHistory.current = false;
            });
        },
        [setNodes, setEdges]
    );

    /* ----------------------------- load ----------------------------- */
    useEffect(() => {
        if (!selected || !flowId) return;
        let cancelled = false;
        void (async () => {
            setLoading(true);
            setError(null);
            try {
                const [flow, catalog, guildRoles, guildChannels, guildTicketTypes, flowResources] = await Promise.all([
                    getFlow(selected.id, flowId),
                    getNodeTypes(),
                    getGuildRoles(selected.id),
                    getGuildChannels(selected.id),
                    // A guild that never set tickets up answers with no types, not an error.
                    getTicketsConfig(selected.id).then((ticketsConfig) => ticketsConfig.types),
                    getFlowResources(selected.id, flowId),
                ]);
                if (cancelled) return;

                setNodeCatalog(catalog);
                setRoles(guildRoles);
                setChannels(guildChannels);
                setTicketTypes(guildTicketTypes);
                setDeclaredResources(flowResources);
                setName(flow.name);
                setEnabled(flow.enabled);
                setGraphIssues(flow.issues);
                setStoredIssueCount(flow.issues.length);
                setSavedVersionAt(flow.updatedAt);
                setCanvasBase(flow.updatedAt);
                setDraftOnlySave(null);
                setDrafts([]);
                setDraftPickerOpen(false);

                rebaseDraft();
                putGraphOnCanvas(flow.graph ?? emptyGraph(), {
                    catalog,
                    roles: guildRoles,
                    channels: guildChannels,
                    ticketTypes: guildTicketTypes,
                });
                setDirty(false);
            } catch (err) {
                const message = err instanceof ApiError ? err.message : 'Failed to load flow';
                if (!cancelled) setError(message);
                return;
            } finally {
                if (!cancelled) setLoading(false);
            }

            /*
             * Then the drafts, after the flow is on screen and never instead of it: a
             * builder that would not open because the drafts could not be listed would
             * be the feature that protects work locking the operator out of it.
             */
            try {
                const found = await listFlowDrafts(selected.id, flowId);
                if (cancelled || found.length === 0) return;
                setDrafts(orderDraftsForPicker(found));
                setDraftPickerOpen(true);
            } catch (err) {
                if (cancelled) return;
                notifications.show({
                    color: 'orange',
                    title: "Couldn't check for drafts",
                    message:
                        err instanceof ApiError
                            ? err.message
                            : 'This is the saved version. Any unfinished drafts are still on the server — reopen the flow to see them.',
                });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [selected, flowId, rebaseDraft, putGraphOnCanvas, setGraphIssues]);

    /**
     * Load a draft from the picker: onto the canvas the way the flow loads, with the
     * draft's own issues on the cards and its name in the box.
     *
     * Dirty, because the canvas is no longer the saved flow — Save would store it. But
     * not written to *my* draft until I change it: the autosave takes this as its
     * baseline, so loading `@alice's draft` does not quietly make it mine. When I do,
     * mine inherits her base: the canvas still descends from the flow she loaded.
     */
    const loadDraft = useCallback(
        (draft: FlowDraft) => {
            rebaseDraft({ mineSavedAt: draft.mine ? draft.updatedAt : undefined });
            setCanvasBase(draft.baseUpdatedAt);
            setName(draft.name);
            putGraphOnCanvas(draft.graph, { catalog: nodeCatalog, roles, channels, ticketTypes });
            setGraphIssues(draft.issues);
            setSelectedNodeId(null);
            setDraftOnlySave(null);
            setDirty(true);
            setDraftPickerOpen(false);
        },
        [rebaseDraft, putGraphOnCanvas, setGraphIssues, nodeCatalog, roles, channels, ticketTypes]
    );

    /** Throw a draft away — anyone's. The picker closes itself once none are left. */
    const discardDraft = useCallback(
        async (draft: FlowDraft) => {
            if (!selected || !flowId) return;
            try {
                await discardFlowDraft(selected.id, flowId, draft.draftId);
                const left = drafts.filter((candidate) => candidate.draftId !== draft.draftId);
                setDrafts(left);
                if (left.length === 0) setDraftPickerOpen(false);
            } catch (err) {
                notifications.show({
                    color: 'red',
                    title: `Couldn't discard ${draftLabel(draft).toLowerCase()}`,
                    message: err instanceof ApiError ? err.message : 'Try again in a second.',
                });
            }
        },
        [selected, flowId, drafts]
    );

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
                    ticketTypes,
                    // Nothing has judged it yet; the next save will.
                    issueCount: 0,
                    // A block just dropped from the palette has no edges, and an
                    // unwired node is deliberately never marked — see
                    // `unreachableNodeIds`. False is also what the effect will say.
                    unreachable: false,
                    // Nothing reaches a block with no edges, let alone two triggers.
                    convergingTriggers: 0,
                    // An unwired node is never warned about — see `unconnectedWarnedExits`.
                    unconnectedExits: [],
                },
            };
            setNodes((prev) => [...prev, node]);
            setSelectedNodeId(id);
            // Every structural edit asks the server again shortly, so a node wired where
            // it cannot run is marked without waiting for a save.
            recheckGraphShape();
        },
        [pushHistory, roles, channels, ticketTypes, setNodes, recheckGraphShape]
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
            recheckGraphShape();
        },
        [pushHistory, setEdges, recheckGraphShape]
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
            markGraphEdited(selectedNodeId, Object.keys(patch));
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
        [selectedNodeId, pushHistory, markGraphEdited, setNodes]
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
            recheckGraphShape();
        },
        [pushHistory, setEdges, recheckGraphShape]
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
        recheckGraphShape();
    }, [selectedNodeId, pushHistory, setNodes, setEdges, recheckGraphShape]);

    /* ---------------------------- history ---------------------------- */

    const restore = useCallback(
        (target: Snapshot) => {
            skipHistory.current = true;
            // An undo edits fields too, just not through a control: what it changed is
            // checked live like any edit, and the server is asked about the canvas it
            // put back, or the marks would still describe the one it replaced.
            for (const node of target.nodes) {
                const before = latest.current.nodes.find((candidate) => candidate.id === node.id);
                if (!before) continue;
                const changed = changedConfigKeys(before.data.config, node.data.config);
                if (changed.length > 0) markGraphEdited(node.id, changed);
            }
            setNodes(target.nodes);
            setEdges(target.edges);
            setDirty(true);
            recheckGraphIssues();
            requestAnimationFrame(() => {
                skipHistory.current = false;
            });
        },
        [setNodes, setEdges, markGraphEdited, recheckGraphIssues]
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

    /** Save the canvas. Resolves `true` once it is persisted — to the flow or, draft-only, to the draft. */
    async function handleSave(): Promise<boolean> {
        if (!selected || !flowId) return false;
        // What is sent, held on to: edits made while the request is in flight are not
        // part of what the answer describes, and the autosave has to know the difference.
        // The issues have to know it too: a field typed into meanwhile stays checked live.
        const sent = canvasPayload;
        const sentAsOf = graphEditMark();
        setSaving(true);
        try {
            // An autosave still on its way would land after this save and put back the
            // draft it deletes. Settled first, and its outcome is not this save's concern.
            await draftAutosave.settle();
            const updated = await updateFlow(selected.id, flowId, {
                ...sent,
                baseUpdatedAt: canvasBase ?? undefined,
            });
            setEnabled(updated.enabled);
            setDirty(false);
            // The live flow's own count, either way: it is what the switch is locked on.
            setStoredIssueCount(updated.issues.length);

            if (updated.savedAs === 'draft') {
                // Live, and incomplete or waiting on its install: kept as my draft, and
                // the flow is as it was. The canvas is persisted — not dirty — and its
                // cards show what the drafted graph lacks. The base does not move: the
                // canvas still descends from the version it was loaded from.
                setGraphIssues(updated.draft.issues, sentAsOf);
                setDraftOnlySave(sent);
                draftAutosave.markDrafted(sent, updated.draft.updatedAt);
                notifications.show({
                    color: 'yellow',
                    title: 'Draft only',
                    message: draftOnlySaveMessage(updated.draft.issues.length, updated.uninstalled),
                });
                return true;
            }

            setName(updated.name);
            setSavedVersionAt(updated.updatedAt);
            setCanvasBase(updated.updatedAt);
            setDraftOnlySave(null);
            draftAutosave.markSavedToFlow(sent);
            // Stored, finished or not: a switched-off flow may hold an incomplete
            // graph, and its issues come back so the cards stay honest about it.
            setGraphIssues(updated.issues, sentAsOf);
            notifications.show(
                updated.issues.length > 0
                    ? {
                          color: 'yellow',
                          title: 'Saved, half-baked',
                          message: `Saved — ${problemCount(updated.issues.length)} to fix before this flow can go live.`,
                      }
                    : {
                          color: 'brand',
                          title: 'Saved',
                          message: `"${updated.name}" is locked in.`,
                      }
            );
            return true;
        } catch (err) {
            // A 400 is a graph too broken to store (dangling edges, duplicate ids). It
            // stored nothing, so the canvas stays dirty — and the autosave keeps it as
            // the operator's draft meanwhile. Cycles are allowed now — loops are
            // guarded by the visit cap.
            const message =
                err instanceof ApiError ? err.message : "Couldn't save. Try again in a second.";
            // Only a refusal with issues is an answer about the canvas. A failure
            // carrying none (a 500, a dropped connection) says nothing about it, so the
            // marks stay as the last answer and the live checks left them — the same
            // rule as a re-check that fails. Clearing them would claim the canvas fixed.
            const issues = err instanceof ApiError ? err.issues : [];
            if (issues.length > 0) setGraphIssues(issues, sentAsOf);
            // Selecting the first errored node is the whole difference between a
            // sentence about a field and knowing which of a dozen blocks it is on.
            const firstBlamed = issues.find((issue) => issue.nodeId)?.nodeId;
            if (firstBlamed) setSelectedNodeId(firstBlamed);
            notifications.show({
                color: 'red',
                title: "That graph won't fly",
                message: issues.length === 0 ? message : summarizeIssues(issues),
            });
            return false;
        } finally {
            setSaving(false);
        }
    }

    /**
     * Throw away the changes on the canvas, and my draft with them — only mine; anyone
     * else's is theirs.
     *
     * The draft is found by asking rather than remembered: it may predate this visit, from
     * a session whose draft the operator chose not to load, and "discard" means none of it
     * is kept. The one exception is a draft-only save made here: that was saved, not a
     * change, so the draft goes back to it rather than away. Any autosave already on its
     * way is let land first, or it would put the draft back after the delete.
     */
    async function discardMyDraft(): Promise<boolean> {
        if (!selected || !flowId) return false;
        const discarded = canvasPayload;
        try {
            await draftAutosave.settle();
            if (draftOnlySave) {
                // Set by the load every save follows, so absent only if that stopped holding.
                if (!canvasBase) throw new Error('A draft-only save with no flow version under it.');
                await saveMyFlowDraft(selected.id, flowId, { ...draftOnlySave, baseUpdatedAt: canvasBase });
            } else {
                const mine = (await listFlowDrafts(selected.id, flowId)).find((draft) => draft.mine);
                if (mine) await discardFlowDraft(selected.id, flowId, mine.draftId);
            }
            // Not left to the pause. A browser Back resolves the held navigation a tick
            // later, so the page re-renders unpaused before it unmounts — and its flush on
            // the way out would write the discarded canvas straight back.
            draftAutosave.markDiscarded(discarded);
            return true;
        } catch (err) {
            notifications.show({
                color: 'red',
                title: "Couldn't discard your draft",
                message: err instanceof ApiError ? err.message : 'Still here, still unsaved. Try again in a second.',
            });
            return false;
        }
    }

    /** Write the canvas to my draft now, and say so if it would not go. */
    async function keepAsDraft(): Promise<boolean> {
        const kept = await draftAutosave.flush();
        if (!kept) {
            notifications.show({
                color: 'red',
                title: "Couldn't keep your draft",
                message: 'Your changes are still on the canvas. Try again, or save.',
            });
        }
        return kept;
    }

    /**
     * Carry out the leave prompt's answer, then let the navigation go — or, if it failed,
     * keep the operator here with the work, and the reason on screen.
     */
    async function handleLeave(action: LeaveAction) {
        setLeaving(action);
        try {
            let done: boolean;
            switch (action) {
                case 'save':
                    done = await handleSave();
                    break;
                case 'keepDraft':
                    done = await keepAsDraft();
                    break;
                case 'discard':
                    done = await discardMyDraft();
                    break;
            }
            if (done) leaveGuard.leave();
            else leaveGuard.stay();
        } finally {
            setLeaving(null);
        }
    }

    async function handleToggleEnabled(next: boolean) {
        if (!selected || !flowId) return;
        const previous = enabled;
        setEnabled(next);
        try {
            const updated = await updateFlow(selected.id, flowId, { enabled: next });
            setStoredIssueCount(updated.issues.length);
            // The cards too, but only while the canvas *is* the stored graph. With
            // unsaved edits on it — or a draft-only save, which is not the stored graph
            // either — these issues describe something else, and the cards are marking
            // the canvas's own answer instead.
            if (!dirty && !savedAsDraftOnly) setGraphIssues(updated.issues);
        } catch (err) {
            setEnabled(previous);
            const message = err instanceof ApiError ? err.message : "Couldn't change that.";
            const issues = err instanceof ApiError ? err.issues : [];
            if (issues.length > 0) {
                // Refused because the stored graph is incomplete — which the switch's
                // own lock should have prevented, so the page's count was stale (a
                // declaration removed elsewhere, say). These issues describe the stored
                // graph, so the count is brought up to date from them — and the cards
                // too, under the same rule as the success path above.
                if (!dirty && !savedAsDraftOnly) setGraphIssues(issues);
                setStoredIssueCount(issues.length);
                notifications.show({ color: 'red', title: message, message: summarizeIssues(issues) });
                return;
            }
            // Includes the install refusal, which carries no issues because nothing on
            // the canvas is wrong — its sentence names what to install.
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
            if (failure.reloadPlan) void loadInstallPlan();
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

    const issuesForNode = useMemo(() => issuesByNode(graphIssues), [graphIssues]);

    /** Whether the switch may not be turned on: the stored graph is not ready to go live. */
    const enableLocked = !enabled && storedIssueCount > 0;

    /** The toolbar's one line about where the work stands. See `builderStatusLine`. */
    const status = builderStatusLine({ dirty, draft: draftAutosave.state, savedAsDraftOnly }, new Date());

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
     * Which exits a block asked to be warned about are left unconnected — the third
     * canvas advisory, computed here for the same reason as the two above.
     */
    const forgottenExits = useMemo(() => unconnectedWarnedExits(nodes, edges), [nodes, edges]);

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
                // Filtered here, once, so the card and the inspector both read the result.
                const unconnectedExits = exitWarningsShown(forgottenExits.get(node.id) ?? NO_EXITS, {
                    failed: count > 0,
                    unreachable,
                });
                if (
                    node.data.issueCount === count &&
                    node.data.unreachable === unreachable &&
                    node.data.convergingTriggers === convergingTriggers &&
                    // By content: the map is rebuilt on every edit, so its lists are
                    // new arrays even when they say the same thing.
                    node.data.unconnectedExits.join('\u0000') === unconnectedExits.join('\u0000')
                ) {
                    return node;
                }
                changed = true;
                return {
                    ...node,
                    data: { ...node.data, issueCount: count, unreachable, convergingTriggers, unconnectedExits },
                };
            });
            return changed ? next : prev;
        });
    }, [issuesForNode, unreachableIds, convergingCounts, forgottenExits, nodes, setNodes]);

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
    const { availableVariables, availableRequirements } = useMemo(
        () => ({
            availableVariables: selectedNodeId
                ? availableVariablesAt(selectedNodeId, nodes, edges)
                : [],
            // All available with nothing selected: no node means no field to advise.
            availableRequirements: selectedNodeId
                ? requirementsAvailableAt(selectedNodeId, nodes, edges)
                : ALL_REQUIREMENTS_AVAILABLE,
        }),
        [selectedNodeId, nodes, edges]
    );

    /** Whether every run this flow can start is about nobody, for the palette to grey by. */
    const runsAboutNobody = useMemo(
        () => flowRunsAboutNobody(nodes.map((node) => node.data.descriptor)),
        [nodes]
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
            {/*
             * Toolbar. Wraps rather than overflowing: its controls need about 880px on one
             * line, and at 1024 the page scrolled sideways by the difference. The body
             * below is `flex: 1`, so a second toolbar line comes out of the canvas's height.
             */}
            <Group
                mih={52}
                py={8}
                px="md"
                gap={8}
                wrap="wrap"
                bg="dark.8"
                style={{ borderBottom: '1px solid var(--mantine-color-dark-5)', flexShrink: 0 }}
            >
                <Tooltip label="Back to flows">
                    <ActionIcon
                        variant="subtle"
                        color="gray"
                        onClick={() => navigate('/flows')}
                        aria-label="Back to flows"
                        style={{ flexShrink: 0 }}
                    >
                        <IconChevronLeft size={18} />
                    </ActionIcon>
                </Tooltip>

                {/*
                 * Flexible rather than a fixed 220px: at 1440 that left most of a spare
                 * row empty while a long name still clipped, and at 1024 a fixed width
                 * ate space the buttons below needed and shrank *them* to unreadable
                 * slivers instead. Growing/shrinking here means the name is what gives
                 * ground first.
                 */}
                <TextInput
                    value={name}
                    onChange={(e) => {
                        setName(e.currentTarget.value);
                        setDirty(true);
                    }}
                    placeholder="Untitled flow"
                    variant="unstyled"
                    style={{ flex: '1 1 120px', minWidth: 100, maxWidth: 480 }}
                    styles={{ input: { fontWeight: 700, fontSize: 14 } }}
                    aria-label="Flow name"
                />

                {/* Moves to its own toolbar line before its buttons shrink, and wraps
                    them only when even a whole line is too narrow, as on a phone. */}
                <Group gap={8} wrap="wrap">
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
                        // Still offered after a draft-only save: switch the flow off, and
                        // Save is how the drafted canvas gets onto it without a dummy edit.
                        disabled={(!dirty && !savedAsDraftOnly) || saving}
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

                    {/*
                     * Locked only in the direction the server would refuse: an
                     * incomplete flow cannot be switched on, but a live one can always
                     * be switched off. The tooltip sits on a wrapper because a disabled
                     * input fires no pointer events for it to hang off.
                     *
                     * Also held while a save is in flight, so this page cannot send a
                     * switch-on judged against the graph that save is replacing.
                     */}
                    <Tooltip
                        label={
                            dirty
                                ? `Save first — the saved version has ${problemCount(storedIssueCount)}`
                                : `Fix ${problemCount(storedIssueCount)} first`
                        }
                        disabled={!enableLocked}
                    >
                        <div>
                            <Switch
                                ml={4}
                                size="sm"
                                color="green"
                                label="Enabled"
                                checked={enabled}
                                disabled={enableLocked || saving}
                                onChange={(e) => void handleToggleEnabled(e.currentTarget.checked)}
                                styles={{ label: { fontSize: 12.5, fontWeight: 600 } }}
                            />
                        </div>
                    </Tooltip>
                </Group>

                <Text
                    size="12px"
                    c={STATUS_TONE_COLOUR[status.tone]}
                    ml="auto"
                    style={{ flexShrink: 0 }}
                >
                    {status.text}
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
                    <NodePalette
                        nodeTypes={nodeCatalog}
                        runsAboutNobody={runsAboutNobody}
                        onAdd={(entry) => addNode(entry)}
                    />
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
                        onDelete={({ nodes: removedNodes, edges: removedEdges }) => {
                            pushHistory({ nodes: removedNodes, edges: removedEdges });
                            recheckGraphShape();
                        }}
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
                        // This column is the scroller. The inspector inside is `min-height:
                        // 100%`, not `height: 100%`: a fixed-height flex column shrinks its
                        // children instead of overflowing, which crushed the Delete button
                        // to 2px on tall blocks.
                        overflowX: 'hidden',
                        overflowY: 'auto',
                    }}
                >
                    {/*
                     * The right column is the selected node's configuration and
                     * nothing else. Resources used to share it behind a tab toggle,
                     * which meant clicking a block while that tab was open showed no
                     * block details at all — a flow-wide concern occupying a
                     * per-node space. It is a toolbar modal now.
                     */}
                    {/*
                     * Leaving any field re-asks what is wrong, so a fixed one stops
                     * being marked without a save. On this wrapper rather than on each
                     * control, so every control — present and future — gets it: React's
                     * `onBlur` is `focusout` and bubbles, through the pickers' portalled
                     * dropdowns too.
                     */}
                    {selectedNode ? (
                        <div onBlur={recheckGraphIssues} style={{ height: '100%' }}>
                            <NodeInspector
                                key={selectedNode.id}
                                descriptor={selectedNode.data.descriptor}
                                nodeType={selectedNode.data.nodeType}
                                label={selectedNode.data.label}
                                config={selectedNode.data.config}
                                roles={roles}
                                channels={channels}
                                ticketTypes={ticketTypes}
                                variables={availableVariables}
                                requirements={availableRequirements}
                                declaredResources={declaredResources}
                                issues={issuesForNode.get(selectedNode.id) ?? []}
                                unconnectedExits={selectedNode.data.unconnectedExits}
                                onChange={updateNodeConfig}
                                onDelete={deleteSelectedNode}
                            />
                        </div>
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
                                            <Text span c={changeLabel(item).color} fw={600}>
                                                {changeLabel(item).label}
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

            {/*
             * Somebody left this flow unfinished — maybe you. Every draft is listed and the
             * operator picks; there are no merge rules, by design. Closing it, or keeping
             * the saved version, leaves every draft where it is.
             *
             * One row per item, each named, with its time and nothing else unless it
             * matters: "flow saved since" is the one fact that changes whether loading a
             * draft is safe, so it is the one note a row can carry.
             */}
            <Modal
                opened={draftPickerOpen}
                onClose={() => setDraftPickerOpen(false)}
                title="Unfinished business"
                size="md"
            >
                <Stack gap="sm">
                    <Text size="12.5px" c="dimmed">
                        Pick what goes on the canvas. Drafts you don&apos;t load stay put
                        {/* One draft per operator, so the next edit is written over theirs. */}
                        {drafts.some((draft) => draft.mine) ? ' — but your next edit replaces yours.' : '.'}
                    </Text>
                    <Group justify="space-between" wrap="nowrap" gap="sm">
                        <div>
                            <Text size="13px" fw={600}>
                                Saved version
                            </Text>
                            <Text size="11.5px" c="dimmed">
                                {savedVersionAt
                                    ? `last saved ${formatWhen(savedVersionAt, new Date())}`
                                    : 'what the flow holds now'}
                            </Text>
                        </div>
                        <Button
                            size="xs"
                            variant="light"
                            color="gray"
                            onClick={() => setDraftPickerOpen(false)}
                            aria-label="Keep the saved version"
                        >
                            Keep
                        </Button>
                    </Group>
                    {drafts.map((draft) => {
                        const label = draftLabel(draft);
                        return (
                            <Group key={draft.draftId} justify="space-between" wrap="nowrap" gap="sm">
                                <div>
                                    <Text size="13px" fw={600}>
                                        {label}
                                    </Text>
                                    <Text size="11.5px" c="dimmed">
                                        edited {formatWhen(draft.updatedAt, new Date())}
                                        {draft.flowSavedSince && (
                                            <Text span size="11.5px" c="orange.4">
                                                {' '}
                                                · flow saved since
                                            </Text>
                                        )}
                                    </Text>
                                </div>
                                <Group gap={6} wrap="nowrap">
                                    <Button
                                        size="xs"
                                        color="brand"
                                        onClick={() => loadDraft(draft)}
                                        aria-label={`Load ${label}`}
                                    >
                                        Load
                                    </Button>
                                    <Button
                                        size="xs"
                                        variant="subtle"
                                        color="red"
                                        onClick={() => void discardDraft(draft)}
                                        aria-label={`Discard ${label}`}
                                    >
                                        Discard
                                    </Button>
                                </Group>
                            </Group>
                        );
                    })}
                </Stack>
            </Modal>

            <LeaveFlowDialog
                opened={leaveGuard.prompting}
                flowName={canvasPayload.name}
                pending={leaving ?? (saving ? 'save' : null)}
                onChoose={(action) => void handleLeave(action)}
                onStay={leaveGuard.stay}
            />

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
