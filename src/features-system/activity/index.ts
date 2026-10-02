/**
 * Activity: a shared record of which member was active in which channel, and when.
 *
 * Under `features-system/` because it is a capability rather than a product feature — it
 * ships no commands, and records every guild's activity whether or not any feature is
 * enabled there. It imports no feature: leveling consumes it through the subscriber seam,
 * and flows reads it through `findLastMessageAt` to tell when a channel went quiet, and
 * through `isBackfillPending` to wait while messages missed during an outage are restored.
 */
export { initActivityTracking } from './initActivityTracking';

export { activityEventsRepo } from './data/activityEventsRepo';
export type { ActivityEventsRepo, LastMessageQuery } from './data/activityEventsRepo';

export { isBackfillPending } from './backfillState';

export { registerActivitySubscriber, clearActivitySubscriber } from './activitySubscribers';
export type { MessageActivityEvent, ReactionActivityEvent, RecordedActivityEvent } from './activitySubscribers';
