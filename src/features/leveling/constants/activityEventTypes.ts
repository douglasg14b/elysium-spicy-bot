/**
 * The kinds of activity that can earn XP.
 *
 * `flow` is XP granted deliberately by a flow rather than earned by being present:
 * it exists as its own member so such a grant cannot borrow another kind's cooldown.
 * Awarding flow XP as `message` would both be dropped whenever the member had just
 * spoken and overwrite `lastMessageXpAt`, silently extending their real cooldown.
 *
 * Stored in a plain `text` column with no CHECK constraint, so adding a member needs
 * no migration. Note that the aggregation switches over this union are deliberately
 * non-exhaustive: a `flow` grant contributes to `totalXp` and to `eventCount` while
 * incrementing no per-kind counter, because it is not a message, a reaction or a
 * voice session and counting it as one would misreport the member's activity.
 */
export const LEVELING_ACTIVITY_EVENT_TYPES = ['message', 'reaction', 'voice', 'flow'] as const;

export type LevelingActivityEventType = (typeof LEVELING_ACTIVITY_EVENT_TYPES)[number];
