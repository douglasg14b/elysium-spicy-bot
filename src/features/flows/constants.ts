/** Bumped when the persisted flow row shape changes (mirrors other features). */
export const FLOW_ENTITY_VERSION = 1;

/** Prefix for flow-trigger button custom_ids: `flow:<flowId>:<nodeId>`. */
export const FLOW_CUSTOM_ID_PREFIX = 'flow';

/**
 * Hard cap on how many nodes a single flow run may visit. Since Phase 5 graphs
 * may legally contain cycles, so this is *the* guard that stops a loop running
 * forever — not merely defence in depth.
 *
 * The count is persisted on the run row and carried across suspend/resume, so a
 * loop that parks on an `action.delay` cannot refill its budget by sleeping.
 */
export const FLOW_MAX_NODE_VISITS = 100;

/**
 * How many times one step may be retried after a transient failure.
 *
 * Deliberately a *separate* budget from {@link FLOW_MAX_NODE_VISITS}: if retries
 * spent visits, a legitimate authored loop plus a flaky Discord API would
 * silently terminate at the visit cap and look like an authoring mistake.
 */
export const FLOW_MAX_RETRY_ATTEMPTS = 5;

/** How often the durable-run poller looks for runs whose `wakeAt` has passed. */
export const FLOW_RUN_POLL_INTERVAL_MS = 15 * 1000;

/** Safety ceiling on `action.delay` — 30 days. */
export const FLOW_MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

/** Most due runs the poller will resume in a single tick. */
export const FLOW_RUN_POLL_BATCH_SIZE = 50;

/**
 * Bumped when a persisted flow-run row can no longer be read by the current repo.
 *
 * Not bumped for a change the repo reads straight through: the `pending` →
 * `suspended` rename and the added `claimedAt` column both leave every existing row
 * fully readable, because the migration rewrote the one value that moved.
 */
export const FLOW_RUN_ENTITY_VERSION = 1;
