/**
 * Flows index for the selected guild. Lists every flow with an inline enable toggle,
 * plus create/delete. "Edit" hands off to the visual builder at `/flows/:flowId`.
 *
 * ## Grouping
 *
 * Flows sharing a journey render as a **band**: a tinted header row carrying the
 * journey's name and its resources, with a rail running down its members. A journey
 * holding one flow is not a group and is not drawn — `flowGrouping.ts` owns every rule
 * about that, because `web/` has no jsdom and a rule living in this file could not be
 * tested.
 *
 * Grouping is made and unmade by dragging a row onto another row (join or create) or out
 * of the band (leave). The outcome is decided on hover and shown on the **target**, so
 * the operator commits to it before releasing rather than reading about it afterwards.
 *
 * The row components are at module scope rather than nested in the page. They call
 * `useDraggable`/`useDroppable`, and a component redefined on every render is a new type
 * each time — React would unmount and remount every row on each keystroke of the rename
 * box, destroying the drag registration and the focus along with it.
 */

import { Fragment, useEffect, useMemo, useRef, useState, type HTMLAttributes } from 'react';
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
    DndContext,
    DragOverlay,
    KeyboardSensor,
    PointerSensor,
    useDraggable,
    useDroppable,
    useSensor,
    useSensors,
    type DragEndEvent,
    type DragOverEvent,
    type DragStartEvent,
    type Announcements,
    type DraggableSyntheticListeners,
    type KeyboardCoordinateGetter,
} from '@dnd-kit/core';
import type { Coordinates } from '@dnd-kit/utilities';
import {
    IconAlertTriangle,
    IconBolt,
    IconCheck,
    IconDownload,
    IconGripVertical,
    IconPencil,
    IconPlus,
    IconRadar,
    IconRoute,
    IconServerCog,
    IconStack2,
    IconTrash,
    IconX,
} from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { createFlow, deleteFlow, listFlows, updateFlow } from '../api/flows';
import {
    detachFlowFromJourney,
    groupFlowWith,
    previewFlowGrouping,
    updateJourney,
} from '../api/journeys';
import type {
    FlowJourneyMembership,
    FlowSummary,
    GroupPreview,
    GroupResolution,
} from '../api/types';
import {
    buildFlowsListRows,
    decideDropOutcome,
    describeDropOutcome,
    dropNeedsConfirmation,
    type DropOutcome,
    type GroupRow,
} from '../flows/flowGrouping';
import { GroupConflictDialog } from '../flows/GroupConflictDialog';
import { installChipFor, INSTALL_QUERY_PARAM } from '../flows/installStateChip';
import { InstalledResourcesDialog } from '../flows/InstalledResourcesDialog';
import { JourneyDriftDialog } from '../flows/JourneyDriftDialog';
import { JourneyResourcesDialog } from '../flows/JourneyResourcesDialog';
import {
    newJourneyNameFor,
    slugifyJourneyName,
    uniqueJourneyKey,
} from '../flows/journeyAttachment';
import { ResourcesDialog, useLoadedResources } from '../flows/ResourcesDialog';
import { LeaveGroupDialog } from '../flows/LeaveGroupDialog';
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

/**
 * The drop zone for "out of every group", as a dnd-kit droppable id.
 *
 * A sentinel rather than a flow id, because leaving is the one gesture with no target
 * row: the operator drags out of the band and into the rest of the list, which
 * `decideDropOutcome` models as a null target.
 */
const UNGROUPED_ZONE_ID = '__ungrouped__';

/** Journey band tints, kept together so a header and its members cannot drift apart. */
const GROUP_HEADER_BG = 'rgba(0, 162, 255, 0.055)';
const GROUP_MEMBER_BG = 'rgba(0, 162, 255, 0.028)';
const GROUP_RAIL = '3px solid var(--mantine-color-brand-6)';
const DROP_TARGET_BG = 'rgba(0, 162, 255, 0.12)';
const DROP_TARGET_RING = 'inset 0 0 0 1px rgba(0, 162, 255, 0.55)';

/**
 * The drop outcomes that name a flow to group with.
 *
 * `none` and `leaveGroup` carry no `targetFlowId`, and the group endpoint has nothing
 * to do without one. Narrowing to these two means the write path cannot be handed an
 * outcome it would have to silently refuse.
 */
type TargetedDropOutcome = Extract<DropOutcome, { targetFlowId: string }>;

/** What the current drag means for one row: how it is tinted, and what it says. */
interface DragState {
    /** True while this row is the one under the cursor. */
    readonly isOver: boolean;
    /** True while this row is the one being dragged. */
    readonly isDragging: boolean;
    /** The hint to show on this row while it is the hovered target. */
    readonly hint: string | null;
    /** Whether releasing here would actually do something. */
    readonly actionable: boolean;
}

const IDLE_DRAG_STATE: DragState = {
    isOver: false,
    isDragging: false,
    hint: null,
    actionable: false,
};

/**
 * Arrow keys step from droppable row to droppable row.
 *
 * dnd-kit's default keyboard getter translates by a fixed 25px, which is a sensible
 * default for free positioning and useless here: rows are of varying height and the
 * gesture is "combine with that row", not "move to that pixel". Without this the grip
 * is focusable and the sensor is mounted but arrowing never actually lands on a target,
 * so the keyboard path would be documented rather than real.
 *
 * Snapping to the nearest droppable centre above or below keeps the pointer and
 * keyboard paths landing on the same set of targets, which is what lets the hint badge
 * mean the same thing in both.
 */
const rowKeyboardCoordinates: KeyboardCoordinateGetter = (
    event,
    { currentCoordinates, context }
) => {
    const step = (direction: -1 | 1): Coordinates | undefined => {
        const containers = [...context.droppableContainers.getEnabled()].flatMap(
            (container) => {
                const rect = container.rect.current;
                // A container that has not measured yet — the ungrouped zone mounts
                // mid-drag — has no centre to aim at and is skipped rather than
                // treated as sitting at the origin.
                if (!rect || container.id === context.active?.id) return [];
                return [{ x: rect.left, y: rect.top + rect.height / 2 }];
            }
        );

        const ahead = containers
            .filter((centre) =>
                direction === 1
                    ? centre.y > currentCoordinates.y + 1
                    : centre.y < currentCoordinates.y - 1
            )
            .sort((left, right) =>
                direction === 1 ? left.y - right.y : right.y - left.y
            );

        return ahead[0];
    };

    switch (event.code) {
        case 'ArrowDown':
            return step(1) ?? currentCoordinates;
        case 'ArrowUp':
            return step(-1) ?? currentCoordinates;
        default:
            return undefined;
    }
};

/** The per-row callbacks, bundled so a row takes one prop rather than five. */
interface FlowRowActions {
    readonly onEdit: (flow: FlowSummary) => void;
    readonly onManage: (flow: FlowSummary) => void;
    readonly onDelete: (flow: FlowSummary) => void;
    readonly onToggle: (flow: FlowSummary, enabled: boolean) => void;
    /**
     * Open the install wizard for this journey.
     *
     * The wizard lives in the builder and stays there — it is a two-step review of a
     * server-built plan, and a second inline copy on this page would be a second place for
     * "what will this create?" to be answered. So this navigates. Deliberately **not** a
     * one-click install from the list: it creates real channels and roles in a live server,
     * which is the reason the builder makes it a reviewed two-step in the first place.
     */
    readonly onInstall: (flowId: string) => void;
}

/**
 * The install chip, plus the button that fixes what it names.
 *
 * Shared by the group header and the ungrouped row because it is the same statement about
 * the same thing — a journey — and the only difference is which flow the wizard opens
 * against. Whether it renders at all is `installChipFor`'s decision, not this component's.
 */
function InstallState({
    journey,
    onInstall,
}: {
    readonly journey: FlowJourneyMembership | null;
    /** The flow to open the builder's wizard on. Any member installs the whole journey. */
    readonly onInstall: () => void;
}) {
    const chip = installChipFor(journey);
    if (!chip) return null;

    return (
        <Group gap={6} wrap="nowrap">
            <Tooltip label={chip.tooltip} withArrow multiline w={260}>
                <Badge size="sm" variant="light" color={chip.color} radius="xl">
                    {chip.label}
                </Badge>
            </Tooltip>
            <Tooltip label="Review and install what this needs">
                <Button
                    size="xs"
                    variant="light"
                    color="brand"
                    leftSection={<IconDownload size={13} />}
                    onClick={onInstall}
                >
                    Install
                </Button>
            </Tooltip>
        </Group>
    );
}

/**
 * The grip. A real focusable button, not a decorated div.
 *
 * Drag-to-combine has no natural keyboard analogue, so dnd-kit's `KeyboardSensor` is
 * what makes this operable at all: focus the grip, press space, arrow between rows,
 * space again to drop. That only works when the element carrying the listeners is
 * genuinely focusable and announces itself, hence the button and a label naming the
 * flow — and it only lands on rows because of `rowKeyboardCoordinates`.
 */
function DragGrip({
    label,
    attributes,
    listeners,
}: {
    readonly label: string;
    readonly attributes: HTMLAttributes<HTMLButtonElement>;
    readonly listeners: DraggableSyntheticListeners;
}) {
    return (
        <button
            type="button"
            aria-label={`Drag ${label} to group it with another flow`}
            {...attributes}
            {...listeners}
            style={{
                display: 'flex',
                alignItems: 'center',
                background: 'transparent',
                border: 'none',
                padding: 0,
                cursor: 'grab',
                color: 'var(--mantine-color-dark-3)',
                flex: 'none',
            }}
        >
            <IconGripVertical size={15} />
        </button>
    );
}

/** One flow row — plain, or a member of a band when `group` is set. */
function FlowRow({
    flow,
    group,
    isLastMember,
    dragState,
    toggling,
    actions,
}: {
    readonly flow: FlowSummary;
    readonly group: GroupRow | null;
    readonly isLastMember: boolean;
    readonly dragState: DragState;
    readonly toggling: boolean;
    readonly actions: FlowRowActions;
}) {
    const draggable = useDraggable({ id: flow.flowId });
    const droppable = useDroppable({ id: flow.flowId });

    const highlighted = dragState.isOver && dragState.actionable;
    const background = highlighted ? DROP_TARGET_BG : group ? GROUP_MEMBER_BG : undefined;
    const cellBackground = group ? { background: background ?? GROUP_MEMBER_BG } : undefined;

    return (
        <Table.Tr
            ref={(node: HTMLTableRowElement | null) => {
                // Both roles on the same row: a flow is a thing you pick up and a thing
                // you can drop onto, and dnd-kit keeps those refs separate.
                draggable.setNodeRef(node);
                droppable.setNodeRef(node);
            }}
            style={{
                background,
                opacity: dragState.isDragging ? 0.45 : undefined,
                boxShadow: highlighted ? DROP_TARGET_RING : undefined,
            }}
        >
            <Table.Td style={group ? { ...cellBackground, borderLeft: GROUP_RAIL } : undefined}>
                <Group gap={8} wrap="nowrap" pl={group ? 14 : 0}>
                    <DragGrip
                        label={flow.name}
                        attributes={draggable.attributes}
                        listeners={draggable.listeners}
                    />
                    {/*
                     * The elbow, only inside a band. It is the one indent cue a member
                     * row gets — the rail does the rest, so ungrouped rows are never
                     * pushed or shrunk and never read as unfiled by comparison.
                     */}
                    {group && (
                        <Text size="11px" c="dark.4" style={{ flex: 'none' }}>
                            └
                        </Text>
                    )}
                    <Text fw={600} size="13.5px">
                        {flow.name}
                    </Text>
                    {/*
                     * The hint lives on the target, not on the floater. Dropping onto a
                     * plain row *creates* a journey and dropping onto a group *joins*
                     * one — same gesture, two outcomes — so the row being hovered is the
                     * only place the difference can honestly be read.
                     */}
                    {dragState.hint && (
                        <Badge size="sm" variant="light" color="brand" radius="xl">
                            {dragState.hint}
                        </Badge>
                    )}
                </Group>
            </Table.Td>
            <Table.Td style={cellBackground}>
                <Badge variant="light" color="gray" radius="xl">
                    {flow.nodeCount}
                </Badge>
            </Table.Td>
            <Table.Td style={cellBackground}>
                <Text size="12.5px" c="dark.2">
                    {formatUpdated(flow.updatedAt)}
                </Text>
            </Table.Td>
            <Table.Td style={cellBackground}>
                <Switch
                    color="green"
                    checked={flow.enabled}
                    disabled={toggling}
                    onChange={(event) => actions.onToggle(flow, event.currentTarget.checked)}
                    aria-label={`Enable ${flow.name}`}
                />
            </Table.Td>
            <Table.Td
                style={
                    // The band closes on its last member with the table's own divider, so
                    // the tint does not bleed into the ungrouped rows below it.
                    group && isLastMember
                        ? { ...cellBackground, borderBottom: '1px solid var(--mantine-color-dark-6)' }
                        : cellBackground
                }
            >
                <Group gap={6} justify="flex-end" wrap="nowrap">
                    {/*
                     * Only on an ungrouped row. A member's install state *is* its journey's,
                     * so repeating it per member would put the same chip on every row of a
                     * band under a header already carrying it — and each copy would offer
                     * an install that does the identical thing.
                     */}
                    {!group && (
                        <InstallState
                            journey={flow.journey}
                            onInstall={() => actions.onInstall(flow.flowId)}
                        />
                    )}
                    <Button
                        size="xs"
                        variant="light"
                        color="brand"
                        leftSection={<IconPencil size={14} />}
                        onClick={() => actions.onEdit(flow)}
                    >
                        Edit
                    </Button>
                    {/*
                     * Hidden on a member row. Inside a journey the resources belong to the
                     * **journey**, and this button opens a per-*flow* inventory — which on a
                     * group member shows one member's share of a shared install beside an
                     * uninstall the server refuses with the shared-journey 409. It promised
                     * something it could not deliver and described something that is not a
                     * per-flow fact.
                     *
                     * The journey's own inventory is on the header, one row up, where it is
                     * both complete and actionable. Ungrouped rows keep this exactly as it
                     * was: for a lone flow the two scopes are the same thing.
                     */}
                    {!group && (
                        <Tooltip label="What it put in your server">
                            <Button
                                size="xs"
                                variant="subtle"
                                color="gray"
                                px={8}
                                onClick={() => actions.onManage(flow)}
                                aria-label={`Manage what ${flow.name} published`}
                            >
                                <IconServerCog size={14} />
                            </Button>
                        </Tooltip>
                    )}
                    <Tooltip label="Delete flow">
                        <Button
                            size="xs"
                            variant="subtle"
                            color="red"
                            px={8}
                            onClick={() => actions.onDelete(flow)}
                            aria-label={`Delete ${flow.name}`}
                        >
                            <IconTrash size={14} />
                        </Button>
                    </Tooltip>
                </Group>
            </Table.Td>
        </Table.Tr>
    );
}

/** The rename state a group header needs, and the two ways out of it. */
interface JourneyRenameControl {
    readonly editing: boolean;
    readonly value: string;
    readonly saving: boolean;
    readonly onStart: (group: GroupRow) => void;
    readonly onChange: (value: string) => void;
    readonly onSave: (journeyKey: string) => void;
    readonly onCancel: () => void;
}

/**
 * The band's header.
 *
 * No node count, no last-updated, no enable switch — empty cells rather than
 * plausible-looking numbers that mean nothing. A journey has no run state; flows do, and
 * one switch silently meaning "all of them" would be a new concept with no engine behind
 * it.
 */
function GroupHeaderRow({
    group,
    rename,
    onOpenResources,
    onOpenInstalled,
    onOpenDrift,
    onInstall,
}: {
    readonly group: GroupRow;
    readonly rename: JourneyRenameControl;
    /** Open the **declarations** editor — what the button's count has always meant. */
    readonly onOpenResources: (group: GroupRow) => void;
    /** Open the teardown inventory — what is actually live in the guild. */
    readonly onOpenInstalled: (group: GroupRow) => void;
    /** Open the drift report — whether what is live still matches the declarations. */
    readonly onOpenDrift: (group: GroupRow) => void;
    readonly onInstall: (flowId: string) => void;
}) {
    const headerCell = { background: GROUP_HEADER_BG };

    return (
        <Table.Tr style={{ background: GROUP_HEADER_BG }}>
            <Table.Td style={{ ...headerCell, borderLeft: GROUP_RAIL }}>
                <Group gap={9} wrap="nowrap">
                    <IconRoute size={15} color="var(--mantine-color-brand-4)" />
                    {rename.editing ? (
                        <Group gap={7} wrap="nowrap">
                            {/*
                             * Never disabled while saving. A disabled input that is being
                             * typed into loses focus to the browser's focus fixup, which
                             * lands the operator's next keystrokes somewhere else
                             * entirely — the Save button carries the busy state instead.
                             */}
                            <TextInput
                                size="xs"
                                data-autofocus
                                autoFocus
                                value={rename.value}
                                onChange={(event) => rename.onChange(event.currentTarget.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' && rename.value.trim()) {
                                        rename.onSave(group.journeyKey);
                                    }
                                    if (event.key === 'Escape') rename.onCancel();
                                }}
                                aria-label={`Rename ${group.name}`}
                                w={220}
                            />
                            <Button
                                size="xs"
                                variant="light"
                                color="brand"
                                loading={rename.saving}
                                disabled={!rename.value.trim()}
                                leftSection={<IconCheck size={13} />}
                                onClick={() => rename.onSave(group.journeyKey)}
                            >
                                Save
                            </Button>
                            <Button
                                size="xs"
                                variant="subtle"
                                color="gray"
                                leftSection={<IconX size={13} />}
                                onClick={rename.onCancel}
                            >
                                Cancel
                            </Button>
                        </Group>
                    ) : (
                        <Tooltip label="Rename this journey">
                            <Text
                                component="button"
                                type="button"
                                fw={800}
                                size="13.5px"
                                onClick={() => rename.onStart(group)}
                                style={{
                                    background: 'transparent',
                                    border: 'none',
                                    padding: 0,
                                    cursor: 'pointer',
                                    color: 'inherit',
                                }}
                            >
                                {group.name}
                            </Text>
                        </Tooltip>
                    )}
                </Group>
                {rename.editing ? (
                    /*
                     * The key is identity — `resource_bindings` and every link row point
                     * at it — so renaming deliberately cannot touch it, and saying so
                     * here is what stops the operator expecting otherwise.
                     */
                    <Text size="11.5px" c="dark.3" mt={7} pl={24}>
                        The key stays{' '}
                        <Text span c="dark.2" ff="monospace" inherit>
                            {group.journeyKey}
                        </Text>{' '}
                        — installed things point at it.
                    </Text>
                ) : (
                    <Text size="11.5px" c="dark.3" mt={2} pl={24}>
                        {group.flows.length} flows · shared resources
                    </Text>
                )}
            </Table.Td>
            <Table.Td style={headerCell} />
            <Table.Td style={headerCell} />
            <Table.Td style={headerCell} />
            <Table.Td style={headerCell}>
                <Group gap={6} justify="flex-end" wrap="nowrap">
                    {/*
                     * The install state, and the way to fix it. First, because it is the
                     * only thing here that can be *wrong* — the rest are ways in.
                     *
                     * The wizard is opened against the first member, and any member would
                     * do: install is a journey-level operation and every flow on the journey
                     * plans the identical thing. That is the one place picking `flows[0]` is
                     * legitimate, and it is legitimate precisely because the choice cannot
                     * change the outcome — unlike the teardown inventory, where it decided
                     * which button messages were listed.
                     */}
                    {group.flows[0] && (
                        <InstallState
                            journey={group.journey}
                            onInstall={() => onInstall(group.flows[0].flowId)}
                        />
                    )}

                    {/*
                     * **Declarations, not installations.** This button's count has always
                     * been `resourceCount` — what the journey *declares* — and it used to
                     * open the teardown inventory, which lists only what is **installed**.
                     * Four declared and nothing installed read "4 resources" and opened a
                     * dialog saying "Nothing live in the server yet". It now opens the
                     * editor those four resources live in, so the count and the contents
                     * are the same promise, and a group's declarations are editable without
                     * going into a member flow's builder to find them.
                     *
                     * No delete: a journey dies when its last flow leaves, not by being
                     * killed while flows still install it.
                     */}
                    <Tooltip label="Edit the channels and roles this journey declares">
                        <Button
                            size="xs"
                            variant="default"
                            leftSection={<IconStack2 size={13} />}
                            onClick={() => onOpenResources(group)}
                            aria-label={`Edit ${group.name}'s resources`}
                        >
                            {group.resourceCount}{' '}
                            {group.resourceCount === 1 ? 'resource' : 'resources'}
                        </Button>
                    </Tooltip>

                    {/*
                     * The teardown inventory, which the button above used to open. Its own
                     * affordance now, wearing the same server-cog the per-flow inventory
                     * wears on ungrouped rows — the two are the same question at two scopes,
                     * so they should look alike and sit in the same place.
                     *
                     * Offered only when something is actually installed. A journey with
                     * nothing live has an inventory whose entire content is "nothing live in
                     * the server yet", which is the state the chip beside it already says
                     * more usefully and with the fix attached.
                     */}
                    {group.journey.installState !== 'none' && (
                        <Tooltip label="What this journey has in your server">
                            <Button
                                size="xs"
                                variant="subtle"
                                color="gray"
                                px={8}
                                onClick={() => onOpenInstalled(group)}
                                aria-label={`Inspect what ${group.name} published`}
                            >
                                <IconServerCog size={14} />
                            </Button>
                        </Tooltip>
                    )}
                    {/*
                     * The drift check, beside the inventory and gated the same way.
                     *
                     * The two are the natural pair: the inventory answers "what is
                     * there", and this answers "is it still what I asked for" — the
                     * question the install chip only appears to answer, since that
                     * reads the binding table rather than the guild.
                     *
                     * No chip on the header for it, deliberately. A chip has to be
                     * earned by being *already known*, and drift is not: finding it
                     * costs a Discord read per resource, so a chip would mean checking
                     * every journey on every page load to decorate rows that are almost
                     * always clean. The button is the honest affordance — it says a
                     * check is available, not that one has been done.
                     */}
                    {group.journey.installState !== 'none' && (
                        <Tooltip label="Check this journey against your server">
                            <Button
                                size="xs"
                                variant="subtle"
                                color="gray"
                                px={8}
                                onClick={() => onOpenDrift(group)}
                                aria-label={`Check ${group.name} for drift`}
                            >
                                <IconRadar size={14} />
                            </Button>
                        </Tooltip>
                    )}

                    {!rename.editing && (
                        <Tooltip label="Rename journey">
                            <Button
                                size="xs"
                                variant="subtle"
                                color="gray"
                                px={8}
                                onClick={() => rename.onStart(group)}
                                aria-label={`Rename ${group.name}`}
                            >
                                <IconPencil size={13} />
                            </Button>
                        </Tooltip>
                    )}
                </Group>
            </Table.Td>
        </Table.Tr>
    );
}

/**
 * The "out of every group" target.
 *
 * Leaving is the one drop with no row to land on, so it needs a target of its own. It
 * is only *shown* while a grouped flow is in the air — an always-visible empty row
 * would be permanent furniture explaining a gesture most operators never make.
 *
 * It stays **mounted** when hidden rather than being added on drag start, though.
 * dnd-kit measures its droppables when a drag begins, and a container that appears
 * after that either goes unmeasured or is measured against a layout that has since
 * reflowed — so the zone would be a target the pointer could not reliably hit. Hiding
 * it with zero-height cells keeps it in the collision graph while costing no space.
 */
function UngroupedZoneRow({
    dragState,
    visible,
}: {
    readonly dragState: DragState;
    readonly visible: boolean;
}) {
    /*
     * Disabled while hidden, not merely unmounted-looking.
     *
     * The row stays mounted so dnd-kit measures it before it is ever needed, but a
     * hidden one is a zero-height rect — and `rectIntersection` requires `top < bottom`,
     * so the pointer can never hit it. The keyboard can: the coordinate getter steps
     * through every *enabled* container with a measured rect, so an ungrouped flow being
     * dragged on a page that has a band could arrow onto an invisible target, get no
     * announcement, and find Space did nothing.
     *
     * `disabled` takes it out of `getEnabled()`, which is what both the getter and
     * collision detection read — one rule in one place, rather than the visibility test
     * duplicated into the getter where it could drift.
     */
    const droppable = useDroppable({ id: UNGROUPED_ZONE_ID, disabled: !visible });

    return (
        <Table.Tr
            ref={droppable.setNodeRef}
            aria-hidden={!visible}
            style={{
                background: dragState.isOver ? DROP_TARGET_BG : undefined,
                boxShadow: dragState.isOver ? DROP_TARGET_RING : undefined,
            }}
        >
            <Table.Td
                colSpan={5}
                style={visible ? undefined : { padding: 0, border: 'none', height: 0 }}
            >
                {visible && (
                    <Group gap={8}>
                        <Text size="12.5px" c="dimmed">
                            Drop here to take it out of its group
                        </Text>
                        {dragState.hint && (
                            <Badge size="sm" variant="light" color="brand" radius="xl">
                                {dragState.hint}
                            </Badge>
                        )}
                    </Group>
                )}
            </Table.Td>
        </Table.Tr>
    );
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
     * The journey being inspected, held as its **key** rather than as the row.
     *
     * The row is re-derived from the current list below. Holding the row itself would
     * freeze the member names at the moment the dialog opened, and the dialog's own
     * teardown triggers a refresh — so a flow that left the group, or a group that
     * dissolved entirely, would keep being named in the sentence telling the operator
     * which flows the next teardown reaches.
     */
    const [managingJourneyKey, setManagingJourneyKey] = useState<string | null>(null);

    /**
     * The journey whose **declarations** are being edited, held as its key.
     *
     * Same reasoning as `managingJourneyKey` above and deliberately a separate piece of
     * state rather than a mode of it: the two dialogs answer different questions about the
     * same journey — what it declares, and what it has live — and one of them writes.
     * Merging them into a `mode` would make every read of this state a two-part question.
     */
    const [editingJourneyKey, setEditingJourneyKey] = useState<string | null>(null);

    /**
     * The journey being checked for drift, held as its key.
     *
     * A third piece of state for the same reason the second exists: this is a third
     * question about the same journey — what it declares, what it has live, and whether
     * those two still agree — and the one that writes to the *guild* rather than to the
     * declaration. A `mode` union would make reading any of them a two-part question.
     */
    const [driftJourneyKey, setDriftJourneyKey] = useState<string | null>(null);

    /** The flow in the air, and the row it is hovering. */
    const [draggingId, setDraggingId] = useState<string | null>(null);
    const [overId, setOverId] = useState<string | null>(null);
    /** True while a group, ungroup or preview is in flight — drives both dialogs. */
    const [grouping, setGrouping] = useState(false);

    /**
     * A drop that stopped to ask, held until the dialog answers.
     *
     * The dragged flow and the outcome are kept alongside the preview because the drag
     * state is cleared the moment the pointer is released: the dialog outlives the
     * gesture that opened it, so it cannot read the answer back out of `draggingId`.
     */
    const [conflict, setConflict] = useState<{
        readonly dragged: FlowSummary;
        readonly outcome: TargetedDropOutcome;
        readonly preview: GroupPreview;
    } | null>(null);
    const [leaving, setLeaving] = useState<FlowSummary | null>(null);

    /** The journey whose name is being edited in place, and the text so far. */
    const [renamingKey, setRenamingKey] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [savingRename, setSavingRename] = useState(false);

    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, { coordinateGetter: rowKeyboardCoordinates })
    );

    /**
     * Where the declarations editor writes, and the list it is editing.
     *
     * Both live here rather than inside `ResourcesDialog` because the dialog is unmounted
     * while closed: state inside it would be discarded on close along with any debounced
     * save still pending, and re-fetched on every reopen. The builder holds its list for
     * the same reason plus one more — its pickers read the declarations to offer channels
     * that do not exist yet.
     *
     * Memoised on the key alone. A new object each render would restart the autosave's
     * debounce on every render and the list would never be written — see `targetRef` in
     * `useResourceAutosave`.
     */
    const editingTarget = useMemo(
        () =>
            editingJourneyKey
                ? ({ kind: 'journey', journeyKey: editingJourneyKey } as const)
                : undefined,
        [editingJourneyKey]
    );
    const journeyResources = useLoadedResources(selected?.id, editingTarget);

    /**
     * Which load is the current one.
     *
     * Four call sites re-read the list and any of them can be in flight when another
     * starts or when the operator switches guild. Without a generation to compare
     * against, whichever response happens to land last wins — which can be an older
     * list, or worse, the previous guild's flows painted into this guild's page.
     */
    const loadGeneration = useRef(0);

    useEffect(() => {
        if (!selected) return;
        const generation = ++loadGeneration.current;
        void (async () => {
            setLoading(true);
            setError(null);
            try {
                const rows = await listFlows(selected.id);
                if (loadGeneration.current === generation) setFlows(rows);
            } catch (err) {
                const message = err instanceof ApiError ? err.message : 'Failed to load flows';
                if (loadGeneration.current === generation) setError(message);
            } finally {
                if (loadGeneration.current === generation) setLoading(false);
            }
        })();
        return () => {
            // Retires this load, so a response arriving after the guild changed — or
            // after unmount — cannot write into state that has moved on.
            loadGeneration.current += 1;
        };
    }, [selected]);

    /**
     * Re-read the whole list.
     *
     * A patch would go stale: grouping changes `memberCount` on rows the operator never
     * touched, and a journey rename changes a header several rows own.
     *
     * `quiet` suppresses the failure toast, for the refresh that follows a refused
     * write. That refusal is already on screen and pinned open — a 409 names the flows
     * blocking it and is the one thing the operator has to read — so a second red toast
     * stacked over it would bury the message that matters behind one about the retry.
     * The list simply stays as it was until the next successful read.
     */
    async function refreshFlows(options?: { readonly quiet?: boolean }): Promise<void> {
        if (!selected) return;
        const generation = ++loadGeneration.current;
        try {
            const rows = await listFlows(selected.id);
            if (loadGeneration.current === generation) setFlows(rows);
        } catch (err) {
            if (options?.quiet) return;
            const message = err instanceof ApiError ? err.message : 'Failed to reload flows';
            notifications.show({ color: 'red', title: "Couldn't refresh", message });
        }
    }

    async function handleToggle(flow: FlowSummary, enabled: boolean) {
        if (!selected) return;
        setTogglingId(flow.flowId);
        // Optimistic — revert if the PUT fails.
        setFlows((prev) =>
            prev.map((row) => (row.flowId === flow.flowId ? { ...row, enabled } : row))
        );
        try {
            const updated = await updateFlow(selected.id, flow.flowId, { enabled });
            setFlows((prev) =>
                prev.map((row) =>
                    row.flowId === flow.flowId
                        ? { ...row, enabled: updated.enabled, updatedAt: updated.updatedAt }
                        : row
                )
            );
        } catch (err) {
            setFlows((prev) =>
                prev.map((row) =>
                    row.flowId === flow.flowId ? { ...row, enabled: flow.enabled } : row
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
     * Hand off to the builder's install wizard.
     *
     * A navigation rather than a new inline install path. The wizard is a two-step review
     * of a plan the *server* builds — it names every create, adopt and blocker, and the
     * apply is refused unless the plan is applicable — and none of that is re-implementable
     * on this page without becoming a second answer to "what will this do to my server".
     *
     * The query parameter is the one piece of new contract: `FlowBuilderPage` opens the
     * dialog when it sees `?install=1` and strips it immediately, so a refresh or a
     * back-navigation does not reopen a wizard the operator has already dismissed.
     */
    function openInstallWizard(flowId: string): void {
        navigate(`/flows/${flowId}?${INSTALL_QUERY_PARAM}=1`);
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

    async function handleDelete() {
        if (!selected || !pendingDelete) return;
        setDeleting(true);
        try {
            await deleteFlow(selected.id, pendingDelete.flowId);
            notifications.show({
                color: 'brand',
                title: 'Gone',
                message: `"${pendingDelete.name}" has been shown the door.`,
            });
            // Closes both halves. The modal is keyed on `managing` now, so clearing
            // only `pendingDelete` would leave it open over a flow that is gone.
            closeManage();
            // Re-read rather than filter: deleting the second-to-last member of a
            // journey dissolves the band, which is a change to a row nobody deleted.
            await refreshFlows();
        } catch (err) {
            const message = err instanceof ApiError ? err.message : "Couldn't delete that flow.";
            notifications.show({ color: 'red', title: "Couldn't delete", message });
        } finally {
            setDeleting(false);
        }
    }

    /**
     * Surface a failed group, ungroup or preview.
     *
     * The server's message is shown verbatim — the shared-journey 409 names the other
     * flows holding the journey back, which is the part the operator has to act on — and
     * that one is pinned open rather than sliding away while it is being read.
     */
    function showGroupingError(err: unknown, title: string): void {
        const isApi = err instanceof ApiError;
        notifications.show({
            color: 'red',
            title,
            message: isApi ? err.message : "Couldn't do that. Try again.",
            autoClose: isApi && err.status === 409 ? false : undefined,
        });
    }

    const flowById = new Map(flows.map((flow) => [flow.flowId, flow]));

    /** What releasing over `targetId` right now would do. */
    function hoveredOutcome(draggedId: string, targetId: string): DropOutcome | null {
        const dragged = flowById.get(draggedId);
        if (!dragged) return null;
        if (targetId === UNGROUPED_ZONE_ID) return decideDropOutcome(dragged, null);
        const target = flowById.get(targetId);
        if (!target) return null;
        return decideDropOutcome(dragged, target);
    }

    function handleDragStart(event: DragStartEvent): void {
        // Leaves the row untracked while a write is in flight, so no hint is offered
        // for an outcome computed against a stale list. `handleDragEnd` holds the
        // guard that actually refuses the write.
        if (grouping) return;
        setDraggingId(String(event.active.id));
        setOverId(null);
    }

    function handleDragOver(event: DragOverEvent): void {
        setOverId(event.over ? String(event.over.id) : null);
    }

    /**
     * Commit the drop, or open the dialog that asks first.
     *
     * The straight-through path is the common one by a distance — a flow with no
     * resources of its own has nothing to lose by moving — and making it confirm would
     * turn a drag into a chore. `dropNeedsConfirmation` owns that judgement.
     */
    async function handleDragEnd(event: DragEndEvent): Promise<void> {
        const draggedId = String(event.active.id);
        setDraggingId(null);
        setOverId(null);

        // Drop anything released while a write is still in flight. `flows` is only
        // re-read once that write lands, so this drop's outcome was computed against a
        // list the server has already moved past — it could group a pair it has just
        // grouped, or send a resolution for a preview that no longer holds.
        if (grouping) return;
        if (!selected || !event.over) return;
        const dragged = flowById.get(draggedId);
        if (!dragged) return;

        const outcome = hoveredOutcome(draggedId, String(event.over.id));
        if (!outcome) return;

        const movingResourceCount = dragged.journey?.resourceCount ?? 0;
        const confirm = dropNeedsConfirmation(outcome, movingResourceCount);

        /*
         * Switched on the outcome rather than on whether it needs confirming, so every
         * arm is visibly handled and `commitGrouping` is only ever reached with an
         * outcome that names a target.
         */
        switch (outcome.kind) {
            case 'none':
                return;

            /*
             * `confirm` is deliberately not consulted here: leaving always asks. The
             * flow stops installing the journey's resources and every node still
             * pointing at one starts failing to save, which is worth a sentence even
             * when the flow declares nothing itself — so `dropNeedsConfirmation` has no
             * zero-resource shortcut on this arm. Branching on the flag anyway would
             * imply it sometimes does, and the branch would be unreachable.
             */
            case 'leaveGroup':
                setLeaving(dragged);
                return;

            case 'createGroup':
            case 'joinGroup': {
                if (!confirm) {
                    await commitGrouping(dragged, outcome, undefined);
                    return;
                }

                // Only the preview knows what actually moves and what each of those
                // things is in Discord right now, so the dialog cannot be composed
                // from the list rows alone.
                setGrouping(true);
                try {
                    const preview = await previewFlowGrouping(
                        selected.id,
                        dragged.flowId,
                        outcome.targetFlowId
                    );
                    setConflict({ dragged, outcome, preview });
                } catch (err) {
                    showGroupingError(err, "Couldn't group those");
                } finally {
                    setGrouping(false);
                }
                return;
            }

            /*
             * Exhaustive by enforcement rather than by coincidence. Every arm above
             * returns, so the switch typechecks today even with an arm missing — which
             * would let a new `DropOutcome` member fall straight through and produce
             * exactly the defect this switch exists to prevent: a drop that does
             * nothing. Same idiom as `cardSummary.ts`.
             */
            default: {
                const unhandled: never = outcome;
                void unhandled;
                return;
            }
        }
    }

    /**
     * Write the grouping.
     *
     * A `createGroup` needs a name and a key for a journey that does not exist yet. Both
     * derive from the **target's** name — the flow being dropped onto is what the group
     * forms around.
     *
     * The name goes through `newJourneyNameFor`, which suffixes it: the header used to read
     * "Flow E" directly above a member row also reading "Flow E", so the container looked
     * like a duplicate of its own first member at the one moment the concept appears. The
     * **key** is still slugged from the bare flow name and not from the suffixed one — a
     * key is identity and a permanent handle, so `flow-e` is a better one than
     * `flow-e-journey`, and it is what an operator renaming the journey later would expect
     * to still see under it.
     *
     * The key is de-duplicated against every journey key on the page, which keeps the
     * common collision out of the save path. The server still owns the constraint.
     */
    async function commitGrouping(
        dragged: FlowSummary,
        // Narrowed to the arms that name a target, so the two that do not cannot reach
        // here by mistake — the compiler refuses them rather than this returning early
        // and a drop doing nothing.
        outcome: TargetedDropOutcome,
        resolution: GroupResolution | undefined
    ): Promise<void> {
        if (!selected) return;

        setGrouping(true);
        try {
            const target = flowById.get(outcome.targetFlowId);
            const newJourney =
                outcome.kind === 'createGroup' && target
                    ? {
                          newJourneyKey: uniqueJourneyKey(
                              slugifyJourneyName(target.name),
                              flows.flatMap((flow) =>
                                  flow.journey ? [flow.journey.journeyKey] : []
                              )
                          ),
                          newJourneyName: newJourneyNameFor(target.name),
                      }
                    : {};

            await groupFlowWith(selected.id, dragged.flowId, {
                targetFlowId: outcome.targetFlowId,
                resolution,
                ...newJourney,
            });
            setConflict(null);
            await refreshFlows();
        } catch (err) {
            showGroupingError(err, "Couldn't group those");
            /*
             * Closed on failure rather than left open to retry. The preview behind it
             * was computed before the refusal and the refusal is usually about
             * something that changed — a shared journey, a key claimed since — so
             * confirming the same stale choice again is the one thing that must not be
             * one click away. The notification carries the server's reason; re-drag to
             * get a preview that is true now.
             */
            setConflict(null);
            /*
             * Refreshed even though the write failed, because it may not have failed
             * cleanly: a `createGroup` creates the journey and attaches the target
             * before it can collide on the merge, so the list can genuinely be stale
             * behind a refusal. Quiet, so a failed reload cannot stack a second toast
             * over the refusal the operator needs to read.
             */
            await refreshFlows({ quiet: true });
        } finally {
            setGrouping(false);
        }
    }

    /** Take a flow out of its journey. Touches nothing already in the server. */
    async function runLeaveGroup(flow: FlowSummary): Promise<void> {
        if (!selected) return;
        setGrouping(true);
        try {
            await detachFlowFromJourney(selected.id, flow.flowId);
            setLeaving(null);
            await refreshFlows();
        } catch (err) {
            showGroupingError(err, "Couldn't take it out");
        } finally {
            setGrouping(false);
        }
    }

    /**
     * Leave the rename editor.
     *
     * The draft is cleared with it. Kept, it would be pre-filled into the next
     * journey's editor — offering one journey's name as another's.
     */
    function closeRename(): void {
        setRenamingKey(null);
        setRenameValue('');
    }

    async function handleRename(journeyKey: string, currentName: string): Promise<void> {
        if (!selected) return;
        const name = renameValue.trim();
        // Enter reaches here without passing the Save button's disabled state, so the
        // guards live here rather than only on the button. An unchanged name closes
        // the editor without a request — a PUT that writes what is already there would
        // still cost a full list refetch.
        if (!name || savingRename) return;
        if (name === currentName) {
            closeRename();
            return;
        }
        setSavingRename(true);
        try {
            // The name only. The key is identity, so it is deliberately not editable.
            await updateJourney(selected.id, journeyKey, { name });
            closeRename();
            await refreshFlows();
        } catch (err) {
            const message = err instanceof ApiError ? err.message : "Couldn't rename that.";
            notifications.show({ color: 'red', title: "Couldn't rename", message });
        } finally {
            setSavingRename(false);
        }
    }

    /**
     * What a screen reader is told as the drag moves.
     *
     * Composed from the same `describeDropOutcome` the badge uses, so the two cannot
     * say different things about the same hover.
     */
    const announcements: Announcements = {
        onDragStart: ({ active }) =>
            `Picked up ${flowById.get(String(active.id))?.name ?? 'flow'}. Use the arrow keys to choose a flow to group it with.`,
        onDragOver: ({ active, over }) => {
            if (!over) return undefined;
            const outcome = hoveredOutcome(String(active.id), String(over.id));
            if (!outcome) return undefined;
            if (outcome.kind === 'none') return outcome.reason;
            return describeDropOutcome(outcome) ?? undefined;
        },
        onDragEnd: ({ active, over }) => {
            if (!over) return 'Cancelled. Nothing changed.';
            const outcome = hoveredOutcome(String(active.id), String(over.id));
            if (!outcome || outcome.kind === 'none') return 'Nothing changed.';
            return `${describeDropOutcome(outcome)}.`;
        },
        onDragCancel: () => 'Cancelled. Nothing changed.',
    };

    /** How one row should render itself for the drag currently in progress. */
    function dragStateFor(rowId: string): DragState {
        if (!draggingId) return IDLE_DRAG_STATE;
        const isDragging = draggingId === rowId;
        if (isDragging) return { ...IDLE_DRAG_STATE, isDragging: true };
        if (overId !== rowId) return IDLE_DRAG_STATE;

        const outcome = hoveredOutcome(draggingId, rowId);
        return {
            isOver: true,
            isDragging: false,
            hint: outcome ? describeDropOutcome(outcome) : null,
            actionable: !!outcome && outcome.kind !== 'none',
        };
    }

    const rows = buildFlowsListRows(flows);
    /**
     * The group the journey dialog is open over, as the current list sees it.
     *
     * Null once the band dissolves — a journey drops below two members and stops being a
     * group — which closes the dialog rather than leaving it open over a row that is no
     * longer on screen.
     */
    const managingGroup =
        rows.find(
            (row): row is GroupRow => row.kind === 'group' && row.journeyKey === managingJourneyKey
        ) ?? null;
    /** The group whose drift report is open, as the current list sees it. See above. */
    const driftGroup =
        rows.find(
            (row): row is GroupRow => row.kind === 'group' && row.journeyKey === driftJourneyKey
        ) ?? null;
    /** The group whose declarations are open, as the current list sees it. See above. */
    const editingGroup =
        rows.find(
            (row): row is GroupRow => row.kind === 'group' && row.journeyKey === editingJourneyKey
        ) ?? null;
    /**
     * The keys the editor must not let follow a rename, as a set.
     *
     * Built here rather than inside the dialog so the array→`Set` conversion does not
     * happen on every keystroke: the panel asks this per row per render, and the list
     * arrives from the wire as an array.
     */
    const editingInstalledKeys = useMemo(
        () => new Set(editingGroup?.journey.installedKeys ?? []),
        [editingGroup]
    );
    const draggedFlow = draggingId ? flowById.get(draggingId) : undefined;
    /**
     * Whether a band exists at all, which is when the leave zone can be needed.
     *
     * Drives *mounting*, not visibility: dnd-kit measures droppables at drag start, so
     * a zone added once the drag is already running is measured late or not at all.
     */
    const hasAnyGroup = rows.some((row) => row.kind === 'group');
    /** True while the flow in the air is one that could actually leave a band. */
    const canLeaveGroup = !!draggedFlow?.journey && draggedFlow.journey.memberCount > 1;

    /**
     * The other flows still on the journey the leaving flow is in.
     *
     * Named in the dialog rather than counted, which is what makes "nothing already in
     * the server is touched" checkable instead of a promise.
     */
    const remainingFlowNames = leaving?.journey
        ? flows
              .filter(
                  (flow) =>
                      flow.flowId !== leaving.flowId &&
                      flow.journey?.journeyKey === leaving.journey?.journeyKey
              )
              .map((flow) => flow.name)
        : [];

    const rowActions: FlowRowActions = {
        onEdit: (flow) => navigate(`/flows/${flow.flowId}`),
        onManage: openManage,
        onDelete: openDelete,
        onToggle: (flow, enabled) => void handleToggle(flow, enabled),
        onInstall: openInstallWizard,
    };

    const renameControl = (group: GroupRow): JourneyRenameControl => ({
        editing: renamingKey === group.journeyKey,
        value: renameValue,
        saving: savingRename,
        onStart: (target) => {
            setRenamingKey(target.journeyKey);
            setRenameValue(target.name);
        },
        onChange: setRenameValue,
        onSave: (journeyKey) => void handleRename(journeyKey, group.name),
        onCancel: closeRename,
    });

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
                    <DndContext
                        sensors={sensors}
                        /*
                         * The spoken half of the hint badge. Everything the badge says
                         * on the hovered row — create, join, refuse — is otherwise
                         * only a colour and a word on screen, which makes the keyboard
                         * path operable but silent about what releasing would do.
                         */
                        accessibility={{ announcements }}
                        onDragStart={handleDragStart}
                        onDragOver={handleDragOver}
                        onDragEnd={(event) => void handleDragEnd(event)}
                        onDragCancel={() => {
                            setDraggingId(null);
                            setOverId(null);
                        }}
                    >
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
                                {rows.map((row) =>
                                    row.kind === 'flow' ? (
                                        <FlowRow
                                            key={row.flow.flowId}
                                            flow={row.flow}
                                            group={null}
                                            isLastMember={false}
                                            dragState={dragStateFor(row.flow.flowId)}
                                            toggling={togglingId === row.flow.flowId}
                                            actions={rowActions}
                                        />
                                    ) : (
                                        /*
                                         * A fragment per band rather than a wrapper
                                         * element: a `<div>` between `<tbody>` and its
                                         * rows is invalid table markup and collapses the
                                         * columns the band shares with every other row.
                                         */
                                        <Fragment key={row.journeyKey}>
                                            <GroupHeaderRow
                                                group={row}
                                                rename={renameControl(row)}
                                                onOpenResources={(group) =>
                                                    setEditingJourneyKey(group.journeyKey)
                                                }
                                                onOpenInstalled={(group) =>
                                                    setManagingJourneyKey(group.journeyKey)
                                                }
                                                onOpenDrift={(group) =>
                                                    setDriftJourneyKey(group.journeyKey)
                                                }
                                                onInstall={openInstallWizard}
                                            />
                                            {row.flows.map((flow, index) => (
                                                <FlowRow
                                                    key={flow.flowId}
                                                    flow={flow}
                                                    group={row}
                                                    isLastMember={index === row.flows.length - 1}
                                                    dragState={dragStateFor(flow.flowId)}
                                                    toggling={togglingId === flow.flowId}
                                                    actions={rowActions}
                                                />
                                            ))}
                                        </Fragment>
                                    )
                                )}
                                {/* Mounted whenever a band exists, shown only mid-drag. */}
                                {hasAnyGroup && (
                                    <UngroupedZoneRow
                                        dragState={dragStateFor(UNGROUPED_ZONE_ID)}
                                        visible={canLeaveGroup}
                                    />
                                )}
                            </Table.Tbody>
                        </Table>

                        {/*
                         * The floating preview portals to `body` rather than cloning the
                         * row in place. A `<tr>` lifted out of its table loses the column
                         * widths it was sized by and collapses.
                         */}
                        <DragOverlay>
                            {draggedFlow && (
                                <Group
                                    gap={9}
                                    px={14}
                                    py={9}
                                    wrap="nowrap"
                                    style={{
                                        background: 'var(--mantine-color-dark-7)',
                                        border: '1px solid var(--mantine-color-brand-6)',
                                        borderRadius: 10,
                                        boxShadow: '0 12px 30px rgba(0, 0, 0, 0.55)',
                                    }}
                                >
                                    <IconGripVertical
                                        size={15}
                                        color="var(--mantine-color-dark-3)"
                                    />
                                    <Text fw={600} size="13.5px">
                                        {draggedFlow.name}
                                    </Text>
                                </Group>
                            )}
                        </DragOverlay>
                    </DndContext>
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
                        onChange={(event) => setNewName(event.currentTarget.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' && newName.trim()) void handleCreate();
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

            {/*
             * One dialog, two ways in. Opened on its own it is an inventory with
             * cleanup; opened by the trash icon it is that same inventory under a
             * delete confirmation, because what a delete leaves behind is the thing
             * the operator most needs to see before agreeing to it.
             *
             * Deleting a flow deliberately touches nothing in the server — an operator
             * who wants the channels gone has to say so, separately and on purpose,
             * using the uninstall inside.
             */}
            {managing && selected && (
                <InstalledResourcesDialog
                    opened
                    onClose={closeManage}
                    guildId={selected.id}
                    flowId={managing.flowId}
                    flowName={managing.name}
                    intro={
                        managingAlone ? undefined : (
                            <Text size="13.5px" c="dimmed">
                                <Text span fw={700} c="bright">
                                    {pendingDelete?.name}
                                </Text>{' '}
                                and its {pendingDelete?.nodeCount ?? 0} node
                                {pendingDelete?.nodeCount === 1 ? '' : 's'} will be deleted for
                                good. Anything below stays in the server unless you remove it
                                here first.
                            </Text>
                        )
                    }
                    extraActions={
                        /*
                         * No "Delete flow" when this was opened on its own. Putting it
                         * there would reintroduce the problem in reverse — someone
                         * tidying up a category would find the button that destroys the
                         * flow sitting under their cursor.
                         *
                         * Appended to the dialog's own bar rather than replacing it, so
                         * the uninstall stays reachable here: "deleting the flow leaves
                         * these channels" is only useful next to the thing that removes
                         * them.
                         */
                        managingAlone ? undefined : (
                            <Button
                                size="xs"
                                color="red"
                                loading={deleting}
                                onClick={() => void handleDelete()}
                            >
                                Delete flow
                            </Button>
                        )
                    }
                />
            )}

            {/*
             * The journey's own inventory, opened from the group header.
             *
             * Separate from the flow dialog above rather than a mode of it: this one acts
             * on the journey, so its teardown reaches every member and is not subject to
             * the shared-journey refusal that would stop the same action started from a
             * single flow. The per-flow dialog stays exactly as it was, for lone flows
             * and for the delete confirmation.
             */}
            {managingGroup && selected && (
                <JourneyResourcesDialog
                    opened
                    onClose={() => setManagingJourneyKey(null)}
                    guildId={selected.id}
                    journeyKey={managingGroup.journeyKey}
                    journeyName={managingGroup.name}
                    flowNames={managingGroup.flows.map((flow) => flow.name)}
                    // Re-read rather than patched: an unpublish changes what the header's
                    // resource count means, and an undeploy changes nothing on the row but
                    // costs one quiet request to stay honest either way.
                    onChanged={() => void refreshFlows({ quiet: true })}
                />
            )}

            {/*
             * The journey checked against the server, opened from the group header.
             *
             * The third question, and the only one of the three that reads the guild
             * itself rather than our record of it. A repair can rename a channel back,
             * which the header shows, so it refreshes on change like the others.
             */}
            {driftGroup && selected && (
                <JourneyDriftDialog
                    opened
                    onClose={() => setDriftJourneyKey(null)}
                    guildId={selected.id}
                    journeyKey={driftGroup.journeyKey}
                    journeyName={driftGroup.name}
                    onChanged={() => void refreshFlows({ quiet: true })}
                />
            )}

            {/*
             * The journey's **declarations**, which is what the header's resource count has
             * always counted. The same editor the builder's toolbar opens, pointed at the
             * journey instead of at a flow — `ResourcesDialog` owns the shell and the
             * autosave, `ResourcesPanel` owns the list, and neither knows which surface
             * rendered it.
             *
             * `installedKeys` comes off the list row, which the route already fills from the
             * same binding scan the chip's count comes from — so this surface and the
             * builder freeze exactly the same keys, and neither pays a request for it. They
             * have to agree: an installed key that follows a rename here would orphan its
             * `resource_bindings` row and every node sidecar naming it, and the group header
             * is the surface most likely to be opened on a journey that is already live.
             */}
            {editingGroup && editingTarget && selected && (
                <ResourcesDialog
                    opened
                    onClose={() => {
                        setEditingJourneyKey(null);
                        // The header's count and the install chip are both derived from
                        // what was just edited. Quiet, because closing a dialog is not a
                        // moment to be told a refresh failed.
                        void refreshFlows({ quiet: true });
                    }}
                    guildId={selected.id}
                    target={editingTarget}
                    title={`Resources ${editingGroup.name} needs`}
                    installedKeys={editingInstalledKeys}
                    resources={journeyResources.resources}
                    onChange={journeyResources.setResources}
                    journeyKey={editingGroup.journeyKey}
                    loaded={journeyResources.loaded}
                    loadError={journeyResources.loadError}
                    onSaved={journeyResources.setResources}
                />
            )}

            <GroupConflictDialog
                opened={!!conflict}
                onClose={() => setConflict(null)}
                preview={conflict?.preview ?? null}
                busy={grouping}
                onConfirm={(resolution) =>
                    conflict
                        ? commitGrouping(conflict.dragged, conflict.outcome, resolution)
                        : Promise.resolve()
                }
            />

            <LeaveGroupDialog
                opened={!!leaving}
                onClose={() => setLeaving(null)}
                flowName={leaving?.name ?? ''}
                journeyName={leaving?.journey?.name ?? ''}
                remainingFlowNames={remainingFlowNames}
                busy={grouping}
                onConfirm={() => (leaving ? runLeaveGroup(leaving) : Promise.resolve())}
            />
        </Stack>
    );
}
