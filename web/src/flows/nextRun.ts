/**
 * The muted "Next run in …" line on a canvas card, worked out without the card knowing
 * what makes a node run: the server lists a next time for whichever nodes have one
 * (`GET …/next-runs`), and the card shows it.
 *
 * A listed time describes the **saved** flow. A node whose config on the canvas differs
 * from what was saved would get a different time once saved, so its card says so rather
 * than showing a countdown that no longer applies.
 */

import type { FlowNextRuns } from '@brattybot/web-sdk';

/** What one card says about its next run. */
export type NodeNextRun =
    | {
          readonly kind: 'at';
          /** The instant, as the server sent it (ISO). */
          readonly at: string;
          /** The zone it was worked out in, for the exact time on hover. */
          readonly timeZone: string;
      }
    | { readonly kind: 'afterSave' };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The relative line: "Next run in 3 hours", "… in 12 minutes", "… in less than a minute",
 * and "… any moment now" once the time has passed — the tick that fires it may not have
 * come round yet, and the card refreshes when it has.
 */
export function describeNextRun(at: Date, now: Date): string {
    const left = at.getTime() - now.getTime();
    if (left <= 0) return 'Next run any moment now';
    if (left < MINUTE_MS) return 'Next run in less than a minute';
    if (left < HOUR_MS) return `Next run in ${plural(Math.floor(left / MINUTE_MS), 'minute')}`;
    if (left < DAY_MS) return `Next run in ${plural(Math.max(1, Math.round(left / HOUR_MS)), 'hour')}`;
    return `Next run in ${plural(Math.round(left / DAY_MS), 'day')}`;
}

/** The line a card shows instead of a countdown while its node has unsaved edits. */
export const NEXT_RUN_AFTER_SAVE = 'Next run is worked out when you save';

/**
 * The exact time, on the 12-hour clock, in the zone it was worked out in:
 * "Thu, Oct 8, 9:00 AM PDT (America/Los_Angeles)".
 */
export function formatNextRunExact(at: Date, timeZone: string): string {
    const formatted = new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZoneName: 'short',
    }).format(at);
    return `${formatted} (${timeZone})`;
}

/**
 * A node's config as a string two configs that say the same thing share — keys sorted at
 * every level, so the order a control happened to write them in never reads as an edit.
 */
export function nodeDataKey(config: unknown): string {
    return JSON.stringify(sortedKeys(config));
}

function sortedKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortedKeys);
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0))
                .map(([key, entry]) => [key, sortedKeys(entry)])
        );
    }
    return value;
}

/**
 * What a node's card says about its next run: nothing when the server listed none for it,
 * the countdown when its config is still the saved one, and the after-save line when it
 * is not — including a node the saved flow does not have, or a canvas opened onto a draft.
 *
 * @param savedData - Each saved node's config, by node id, as {@link nodeDataKey} reads it.
 */
export function nextRunForNode(
    nodeId: string,
    config: Record<string, unknown>,
    nextRuns: FlowNextRuns | null,
    savedData: ReadonlyMap<string, string>
): NodeNextRun | null {
    const at = nextRuns?.nextRuns[nodeId];
    if (!nextRuns || !at) return null;
    return savedData.get(nodeId) === nodeDataKey(config) ? { kind: 'at', at, timeZone: nextRuns.timeZone } : { kind: 'afterSave' };
}

/** Whether two cards' next-run lines say the same thing. */
export function sameNextRun(first: NodeNextRun | null, second: NodeNextRun | null): boolean {
    if (first === null || second === null) return first === second;
    if (first.kind === 'afterSave' || second.kind === 'afterSave') return first.kind === second.kind;
    return first.at === second.at && first.timeZone === second.timeZone;
}

/**
 * Whether any listed time has already passed — while one has, the page asks again every
 * minute, so the countdown moves on once the tick has fired it, even if the time stays
 * overdue for a while first.
 */
export function anyNextRunPassed(nextRuns: FlowNextRuns | null, now: Date): boolean {
    return Object.values(nextRuns?.nextRuns ?? {}).some((at) => new Date(at).getTime() <= now.getTime());
}
