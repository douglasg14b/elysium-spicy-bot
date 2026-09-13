/**
 * The run lifecycle — the interpreter's own state machine, and one of only two it
 * owns. It lives beside the schema that persists it so the status names in the
 * code and the values in the column can never need a translation layer.
 *
 * **This member set is frozen.** If a later feature appears to need a sixth
 * status, the block contract is wrong; treat it as a friction report rather than
 * an enum addition.
 */
export const FLOW_RUN_STATUSES = ['suspended', 'running', 'completed', 'failed', 'cancelled'] as const;

export type FlowRunStatus = (typeof FLOW_RUN_STATUSES)[number];

/**
 * Every event that may move a durable run between statuses. Frozen alongside
 * {@link FlowRunStatus}.
 */
export const FLOW_RUN_EVENTS = ['claim', 'park', 'release', 'reclaim', 'complete', 'fail', 'cancel'] as const;

export type FlowRunEvent = (typeof FLOW_RUN_EVENTS)[number];

export interface FlowRunTransition {
    /**
     * The statuses this event is legal from. Doubles as the guard for a
     * conditional write, so the predicate on the UPDATE and the status it lands
     * on cannot drift apart.
     */
    readonly from: readonly FlowRunStatus[];
    /** The status this event lands on. */
    readonly to: FlowRunStatus;
}

/**
 * The run lifecycle as one total table. This is the only place a transition is
 * described; every persisted status write derives both its guard and its target
 * from here.
 *
 * Three events share the `running → suspended` transition because they are three
 * genuinely different things happening, and a log or an audit trail wants to tell
 * them apart:
 *
 * * `park` — the run reached a suspending block and asked to be put down.
 * * `release` — a resumer hit a fault unrelated to the run and handed its own
 *   claim straight back, so the next poll retries.
 * * `reclaim` — the startup sweep took a claim off a process that died holding it.
 *
 * There is no event ending a run "deliberately but not successfully". A flow ends
 * when its last block runs, and `completed` is a statement about the run, never a
 * claim that the journey it drove succeeded.
 *
 * `cancel` is the operator's move and is the one event legal from `running`
 * without holding the claim. **It does not interrupt an in-flight segment**: the
 * blocks already running will finish their side effects, and the resumer's
 * terminal write is then rejected loudly by {@link nextRunStatus}. Cooperative
 * cancellation — checking at each node boundary — belongs with the operations
 * view that first exposes cancelling.
 */
export const FLOW_RUN_TRANSITIONS = {
    claim: { from: ['suspended'], to: 'running' },
    park: { from: ['running'], to: 'suspended' },
    release: { from: ['running'], to: 'suspended' },
    reclaim: { from: ['running'], to: 'suspended' },
    complete: { from: ['running'], to: 'completed' },
    fail: { from: ['running'], to: 'failed' },
    cancel: { from: ['suspended', 'running'], to: 'cancelled' },
} as const satisfies Record<FlowRunEvent, FlowRunTransition>;

/** Raised when a run is asked to make a transition the lifecycle does not allow. */
export class IllegalFlowRunTransitionError extends Error {
    constructor(
        readonly from: FlowRunStatus,
        readonly event: FlowRunEvent
    ) {
        super(
            `Illegal flow-run transition: cannot ${event} a run that is ${from} ` +
                `(legal from: ${FLOW_RUN_TRANSITIONS[event].from.join(', ')})`
        );
        this.name = 'IllegalFlowRunTransitionError';
    }
}

/** Whether `event` may be applied to a run currently in `from`. */
export function isLegalRunTransition(from: FlowRunStatus, event: FlowRunEvent): boolean {
    return (FLOW_RUN_TRANSITIONS[event].from as readonly FlowRunStatus[]).includes(from);
}

/**
 * The status a run lands on after `event`.
 *
 * Total over the status/event product: an illegal pairing throws
 * {@link IllegalFlowRunTransitionError} rather than returning the current status,
 * because a lifecycle that silently no-ops is how a run ends up in a state nobody
 * can explain.
 */
export function nextRunStatus(from: FlowRunStatus, event: FlowRunEvent): FlowRunStatus {
    if (!isLegalRunTransition(from, event)) {
        throw new IllegalFlowRunTransitionError(from, event);
    }
    return FLOW_RUN_TRANSITIONS[event].to;
}
