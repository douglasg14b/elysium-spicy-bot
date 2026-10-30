/**
 * Who an id is, as the bot remembers them (`docs/plans/member-names.md` §4): the name a
 * person goes by now, for any page that shows an id — members and leavers alike.
 *
 * The rules live here and the fetching in `useMemberNames`, so the rules can be tested
 * without a query client.
 */

import type { MemberName } from '@brattybot/web-sdk';

/** The names a view's ids resolved to, by user id. An id missing is not known (yet). */
export type MemberNames = ReadonlyMap<string, MemberName>;

/** No names: what a view holds before its answer lands, one reference for every render. */
export const NO_MEMBER_NAMES: MemberNames = new Map();

/** The route's own cap on ids per request (`memberNameBody.ts`). */
export const MEMBER_NAME_IDS_PER_REQUEST = 100;

/**
 * Whether `value` is shaped like a Discord user id — 17 to 20 digits, as the routes take
 * one. Anything else could never have a name, and would refuse a whole names request.
 */
export function isUserId(value: string): boolean {
    return /^\d{17,20}$/.test(value);
}

/**
 * The name somebody goes by in this server now: their server nickname, else their display
 * name, else their handle. `||` rather than `??`: an empty name is as unusable as a missing one.
 */
export function memberNameLabel(name: MemberName): string {
    return name.nickname || name.globalName || name.username;
}

/**
 * The `ids` of each request a view sends for the ids it shows: distinct, sorted — so the
 * same people in another order are the same request, and its cached answer — and at most
 * {@link MEMBER_NAME_IDS_PER_REQUEST} to a request.
 */
export function memberNameRequests(userIds: Iterable<string>): string[] {
    const sorted = [...new Set(userIds)].filter(isUserId).sort();
    const requests: string[] = [];
    for (let offset = 0; offset < sorted.length; offset += MEMBER_NAME_IDS_PER_REQUEST) {
        requests.push(sorted.slice(offset, offset + MEMBER_NAME_IDS_PER_REQUEST).join(','));
    }
    return requests;
}
