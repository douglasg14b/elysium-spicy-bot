import type { FlowRunWaitConfig, FlowWaitKind } from '../data/flowRunsSchema';

/**
 * The interpreter's step outcome — the second and last state machine the flow
 * engine owns. Every block's runtime entry point returns one of these, which is
 * what lets the executor stop naming individual block types.
 *
 * **This member set is frozen.** A flow ends when its last block runs, so there
 * is no deliberate-termination member: a path with nothing after it simply
 * completes. A transient failure is a `suspend` carrying a {@link FlowRetryMarker},
 * not a fourth member. If a later feature appears to need one, the block
 * contract is wrong — treat it as a friction report, not an enum addition.
 */
export const FLOW_STEP_OUTCOME_KINDS = ['continue', 'suspend', 'fail'] as const;

export type FlowStepOutcomeKind = (typeof FLOW_STEP_OUTCOME_KINDS)[number];

/**
 * Marks a suspension as "park and try this step again" rather than "park until
 * something happens". Its budget is `FLOW_MAX_RETRY_ATTEMPTS` in `../constants.ts`,
 * deliberately separate from the node-visit budget: a flaky Discord call must not
 * be able to spend the visits a legitimate authored loop needs.
 *
 * M1 declares the shape only. Nothing produces a retry marker yet — classifying
 * a transient Discord failure and re-parking on it is M3's work.
 */
export interface FlowRetryMarker {
    /** Retry attempts already spent on this step, carried across resumes. */
    attemptsUsed: number;
    /** Why the step is being retried, for the run log and the operations view. */
    reason: string;
}

/**
 * What a block asks for when it parks a run. Only what the block itself knows —
 * the executor supplies the resume position, the visit budget, and the log.
 */
export interface FlowStepSuspension {
    /** When the parked run becomes due. Omitted when it waits solely on an event. */
    wakeAt?: Date;
    /** Set when parked on a gateway event rather than a plain delay. */
    waitKind?: FlowWaitKind;
    waitConfig?: FlowRunWaitConfig;
    /**
     * The message this park posted, when it parked by putting controls in a
     * channel.
     *
     * Named by the block because only the block knows it posted anything; carried
     * on the suspension rather than held in memory for the same reason `variables`
     * is — the press that ends this park may arrive in a different process, days
     * later, and the message id would otherwise be gone.
     *
     * It is what makes one park at a node distinguishable from the next at the
     * same node, so a claim can name which park it is resuming. See
     * `FlowRunTable.waitMessageId`.
     */
    waitMessageId?: string;
    /** Present only when parking to retry a transient failure. */
    retry?: FlowRetryMarker;
}

/**
 * One step's result: carry on (optionally naming which output handle to leave
 * by), park the run, or fail it.
 */
export type FlowStepOutcome =
    | {
          kind: 'continue';
          /**
           * Which declared output handle to follow. Omitted by a block with a
           * single output, whose one outgoing edge needs no naming.
           */
          handle?: string;
      }
    | { kind: 'suspend'; suspension: FlowStepSuspension }
    | { kind: 'fail'; error: string };
