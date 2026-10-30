import { createPerGuildQueue } from '../../shared/perGuildQueue';

/**
 * Every member-names write for one guild — the startup sweep, the gateway listeners, the
 * dashboard's lookups — runs on this queue, one at a time, so no two can interleave the
 * repo's read-merge-write of a member's nicknames.
 */
export const memberNamesQueue = createPerGuildQueue();
