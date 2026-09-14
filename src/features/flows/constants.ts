/** Bumped when the persisted flow row shape changes (mirrors other features). */
export const FLOW_ENTITY_VERSION = 1;

/** Prefix for flow-trigger button custom_ids: `flow:<flowId>:<nodeId>`. */
export const FLOW_CUSTOM_ID_PREFIX = 'flow';

/**
 * Prefix for the buttons a parked run posts to ask a question:
 * `flowc:<runId>:<nodeId>:<index>`.
 *
 * **A second prefix rather than a fourth segment on the first.** `parseFlowCustomId`
 * returns null on anything but exactly three segments, so extending that scheme in
 * place would break every trigger button already deployed in a guild.
 *
 * These two are safe alongside each other **because `resolveDynamicHandler` keeps
 * the longest matching prefix**, and it is worth being exact about that, because
 * the tempting explanation is wrong. It is not the trailing colon:
 * `'flowc:…'.startsWith('flow:')` is false, so with both colons there is no
 * contest — but drop the trigger prefix's colon and `'flowc:…'` *does* match
 * `'flow'`, and answers still route here, because `'flowc:'` is longer. Length is
 * what decides, not punctuation and not registration order.
 *
 * What the colon does buy is a guarantee that survives the next prefix somebody
 * adds: `flow` bare would also match a hypothetical `flowsomething:`, where
 * `flow:` cannot. Keep both colons for that reason rather than for this one.
 * `registerDynamic` throws only on an exact duplicate prefix and will not warn.
 */
export const FLOW_CHOICE_CUSTOM_ID_PREFIX = 'flowc';

/**
 * Discord's hard cap on a component `custom_id`, in characters.
 *
 * Load-bearing rather than documentation: a run whose ids would exceed it must
 * fail while building the message, naming the run and the node, rather than
 * having Discord reject the whole post at send time with a validation error that
 * names none of them.
 */
export const DISCORD_CUSTOM_ID_MAX_LENGTH = 100;

/**
 * Discord's hard cap on a button's visible label, in characters.
 *
 * Held by the block's schema rather than trusted: Discord rejects the whole
 * message when a label is over, so an author who pastes a sentence would
 * otherwise get a failed run at ask time instead of a save they can fix.
 */
export const DISCORD_BUTTON_LABEL_MAX_LENGTH = 80;

/**
 * Most choices one question may offer.
 *
 * Discord's own limit on buttons in a single action row. A question needing more
 * than five wants a select menu, which `SupportedInteractionBuilder` does not
 * carry yet — so this is the real ceiling, not a cautious one.
 */
export const FLOW_MAX_CHOICES = 5;

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

/**
 * Hard cap on the serialised size, in **bytes**, of a run's variable bag.
 *
 * {@link FLOW_MAX_NODE_VISITS} bounds how many nodes a run visits, not how much
 * each one writes, so a loop containing a block that records a value is otherwise
 * unbounded — and the bag is persisted, so an unbounded one is an unbounded row.
 *
 * Exceeding it fails the run naming the key and the cap. Never a silent drop: a
 * variable that vanished would send a later block down a branch its author never
 * drew, which is far worse than a run that stops and says why.
 */
export const FLOW_MAX_VARIABLES_SIZE = 16 * 1024;

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
 *
 * **2** since the context snapshot gained `channelId`. The bump is about the
 * direction that genuinely breaks: a rolled-back binary would hand a v2 snapshot
 * to a schema that does not know the key, which is exactly this constant's stated
 * bump condition. Forwards is unaffected — `channelId` is optional, so a v1 row
 * reads cleanly as a run that recorded no channel.
 *
 * It is deliberately **not a read-time discriminator**. Nothing branches on it:
 * the old and new keys are disjoint, so there is no shape to disambiguate, and a
 * version check at read time would be a second mechanism for a fact the schema
 * already states — one that could disagree with it.
 */
export const FLOW_RUN_ENTITY_VERSION = 2;
