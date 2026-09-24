import type { FlowJourneyMembership, FlowSummary } from '../api/types';

/**
 * Turning a flat flow list into the rows the flows page draws.
 *
 * All of the grouping judgement lives here rather than in the page, because it is the
 * part with rules worth testing and `web/` has no jsdom to test a component with. The
 * page maps these rows to markup and does not decide anything.
 *
 * **The rule everything else follows from: a journey of one is not a group.** Every flow
 * that declares a resource has a journey — that is the implicit single-flow case the
 * engine is built on — so treating "has a journey" as "is grouped" would nest almost
 * every flow under a header naming a concept its author never asked for (PRD §5.8).
 * Grouping appears only at two members, and disappears again at one.
 */

/** A plain, ungrouped flow: rendered exactly as the page did before grouping existed. */
export interface UngroupedRow {
    readonly kind: 'flow';
    readonly flow: FlowSummary;
}

/** A journey holding two or more flows, with its members in list order. */
export interface GroupRow {
    readonly kind: 'group';
    readonly journeyKey: string;
    readonly name: string;
    readonly resourceCount: number;
    readonly flows: readonly FlowSummary[];
    /**
     * The journey as the list route reports it, for the header's install chip.
     *
     * Carried whole rather than as another flattened field. `installChipFor` takes a
     * membership precisely so a caller cannot pair one journey's state with another's
     * count, and re-flattening it here would hand that mistake straight back. `journeyKey`,
     * `name` and `resourceCount` stay as their own members because every existing caller
     * reads them and widening the row is not a reason to churn them.
     */
    readonly journey: FlowJourneyMembership;
}

export type FlowsListRow = UngroupedRow | GroupRow;

/**
 * Arrange flows into rows, grouping only journeys that hold more than one.
 *
 * Order is preserved from the incoming list — which the server returns oldest-first —
 * and a group takes the position of its **earliest** member. Sorting groups to the top
 * would reshuffle the page the instant two flows were joined, moving rows the operator
 * was not touching; anchoring to the first member keeps everything else where it was.
 */
export function buildFlowsListRows(flows: readonly FlowSummary[]): FlowsListRow[] {
    const membersByKey = new Map<string, FlowSummary[]>();
    for (const flow of flows) {
        if (!flow.journey || flow.journey.memberCount < 2) continue;
        const existing = membersByKey.get(flow.journey.journeyKey);
        if (existing) {
            existing.push(flow);
        } else {
            membersByKey.set(flow.journey.journeyKey, [flow]);
        }
    }

    const rows: FlowsListRow[] = [];
    const emitted = new Set<string>();

    for (const flow of flows) {
        const journey = flow.journey;
        const members = journey ? membersByKey.get(journey.journeyKey) : undefined;

        // `members` is only set for journeys that passed the two-member test above, so a
        // lone flow with a journey falls through to the plain row below untouched.
        if (!journey || !members) {
            rows.push({ kind: 'flow', flow });
            continue;
        }

        if (emitted.has(journey.journeyKey)) continue;
        emitted.add(journey.journeyKey);

        rows.push({
            kind: 'group',
            journeyKey: journey.journeyKey,
            name: journey.name,
            resourceCount: journey.resourceCount,
            flows: members,
            journey,
        });
    }

    return rows;
}

/**
 * What releasing the drag over a given row would do.
 *
 * Computed on hover so the hint can be shown on the target *before* the mouse is
 * released — the outcome is committed to in advance rather than explained afterwards.
 * The same function decides whether the drop is allowed at all.
 */
export type DropOutcome =
    /** Nothing would happen: same flow, or already where it would land. */
    | { readonly kind: 'none'; readonly reason: string }
    /** Two ungrouped flows would become a new journey. */
    | { readonly kind: 'createGroup'; readonly targetFlowId: string }
    /** The dragged flow would join the journey the target already has. */
    | { readonly kind: 'joinGroup'; readonly targetFlowId: string; readonly journeyName: string }
    /** The dragged flow would leave its journey and stand alone. */
    | { readonly kind: 'leaveGroup'; readonly journeyName: string };

/**
 * Decide what dropping `dragged` onto `target` means.
 *
 * `target` is null for the drop zone outside every group — the gesture that ungroups.
 * A flow already in the target's journey yields `none`, so hovering its own group-mates
 * says "already in X" rather than offering a move that would do nothing.
 */
export function decideDropOutcome(
    dragged: FlowSummary,
    target: FlowSummary | null
): DropOutcome {
    const draggedJourney = dragged.journey;
    const draggedIsGrouped = !!draggedJourney && draggedJourney.memberCount > 1;

    if (!target) {
        if (!draggedIsGrouped) {
            return { kind: 'none', reason: 'Not in a group.' };
        }
        return { kind: 'leaveGroup', journeyName: draggedJourney.name };
    }

    if (target.flowId === dragged.flowId) {
        return { kind: 'none', reason: 'Same flow.' };
    }

    const targetJourney = target.journey;
    const targetIsGrouped = !!targetJourney && targetJourney.memberCount > 1;

    if (draggedJourney && targetJourney && draggedJourney.journeyKey === targetJourney.journeyKey) {
        return { kind: 'none', reason: `Already in ${targetJourney.name}.` };
    }

    if (targetIsGrouped) {
        return { kind: 'joinGroup', targetFlowId: target.flowId, journeyName: targetJourney.name };
    }

    return { kind: 'createGroup', targetFlowId: target.flowId };
}

/** The hint shown on the hovered row. Null when there is nothing to say. */
export function describeDropOutcome(outcome: DropOutcome): string | null {
    switch (outcome.kind) {
        case 'none':
            return null;
        case 'createGroup':
            return 'Group these two';
        case 'joinGroup':
            return `Add to ${outcome.journeyName}`;
        case 'leaveGroup':
            return `Leave ${outcome.journeyName}`;
    }
}

/**
 * Whether the drop needs to stop and ask.
 *
 * A move with nothing to lose goes straight through — the overwhelmingly common case,
 * and making it confirm would turn a drag into a chore. The dialog is earned by the flow
 * having resources of its own, because that is when the operator has a real choice.
 */
export function dropNeedsConfirmation(outcome: DropOutcome, movingResourceCount: number): boolean {
    if (outcome.kind === 'none') return false;
    // Leaving a group always confirms: the flow stops installing the journey's
    // resources, and nodes pointing at them will start failing to save.
    if (outcome.kind === 'leaveGroup') return true;
    return movingResourceCount > 0;
}
