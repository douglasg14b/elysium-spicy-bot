/**
 * Activity: a shared record of which member was active in which channel, and when.
 *
 * Under `features-system/` because it is a capability rather than a product feature — it
 * ships no commands, and records every guild's activity whether or not any feature is
 * enabled there. It imports no feature: leveling and flows consume it through the
 * subscriber seam (XP; waking runs waiting on a message, and starting Message Sent runs).
 * Flows also reads it through `findLastMessageAt` to tell when a channel went quiet,
 * `findLastMessageBetween` to find a reply sent while the bot was down, and
 * `isBackfillPending`/`whenBackfillFinished` to wait while messages missed during an
 * outage are restored.
 */
export { initActivityTracking } from './initActivityTracking';

export { activityEventsRepo } from './data/activityEventsRepo';
export type { ActivityEventsRepo, LastMessageQuery, MessageBetweenQuery } from './data/activityEventsRepo';

export { isBackfillPending, whenBackfillFinished } from './backfillState';

export { registerActivitySubscriber, clearActivitySubscriber } from './activitySubscribers';
export type { MessageActivityEvent, ReactionActivityEvent, RecordedActivityEvent } from './activitySubscribers';
