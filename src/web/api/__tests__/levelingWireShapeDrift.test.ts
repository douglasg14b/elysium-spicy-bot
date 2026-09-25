import { describe, expect, it } from 'vitest';
import {
    LEVELING_ACTIVITY_BUCKET_KEYS,
    LEVELING_ACTIVITY_CHART_KEYS,
    LEVELING_ACTIVITY_SUMMARY_KEYS,
    LEVELING_LIST_RESULT_KEYS,
    LEVELING_MEMBER_KEYS,
    LEVELING_RANKING_ROW_KEYS,
    LEVELING_USER_DETAIL_KEYS,
    LEVELING_USER_METRICS_KEYS,
} from '../levelingRoutes';
/*
 * The two vocabularies come from the modules that *own* them, not from the route's
 * convenience re-exports.
 *
 * Via the aliases, deleting `LEVELING_STATS_PERIODS` from `levelingRoutes.ts` — a tidy-up
 * that looks safe, since no handler reads it — would break this file at import and report
 * as a missing export rather than as the vocabulary drift it is. Reading the owner means
 * the gate survives that edit and still compares what the server actually emits.
 */
import { STATS_PERIODS } from '../../../features/leveling/logic/statsPeriod';
import { ACTIVITY_STATUSES } from '../../../features/leveling/cards/statsCard/statsCardMetrics';
import * as browserTypes from '../../../../web/src/api/types';

/**
 * The drift gate between the leveling wire shapes and the browser's copy of them.
 *
 * Every shape here exists twice: once on the server in `levelingRoutes.ts` and once as a
 * hand-written interface in `web/src/api/types.ts`. It **has** to exist twice — a single
 * `import type` from `src/` inside `web/src/` pulls the whole bot source tree into the
 * browser project's compilation and breaks `pnpm build:web` — so this test is what stops
 * the copy rotting, in place of the type system.
 *
 * **The comparison is data, not text**, exactly as `ticketWireShapeDrift.test.ts` does it.
 * Each side exports `as const` member lists that its *own* `tsc` holds to the interface in
 * both directions: `satisfies` rejects a name that is not a member, and a companion
 * conditional type rejects a member missing from the list. So this test only compares
 * arrays, and no part of the gate depends on how either file is formatted.
 *
 * The import below crosses into the web workspace deliberately, and is safe for the same
 * reason the ticket one is: `types.ts` is a leaf of types and frozen arrays, pulling in no
 * React, no DOM and no bot code. The reverse direction is what cannot work.
 */

const REMEDY =
    'Reconcile the leveling interfaces and their *_KEYS arrays in `web/src/api/types.ts` with ' +
    'the wire shapes in `src/web/api/levelingRoutes.ts`. Both sides export member lists their ' +
    'own compiler holds to the interface, so the fix is to add the member in both places.';

/**
 * Each shape paired with its two member lists.
 *
 * Table-driven so adding a wire shape means one row rather than a copied test, and so a
 * failure names which shape drifted rather than only that something did.
 *
 * The nested shapes get their own rows on purpose. `LevelingUserDetail` gates `metrics` and
 * `activityChart` by name alone, which says nothing about what is inside them — a
 * fifteenth metric or a sixth bucket column would leave every parent row green while the
 * panel that reads it renders nothing.
 */
const SHAPES = [
    { name: 'LevelingMember', server: LEVELING_MEMBER_KEYS, browser: browserTypes.LEVELING_MEMBER_KEYS },
    {
        name: 'LevelingRankingRow',
        server: LEVELING_RANKING_ROW_KEYS,
        browser: browserTypes.LEVELING_RANKING_ROW_KEYS,
    },
    {
        name: 'LevelingListResult',
        server: LEVELING_LIST_RESULT_KEYS,
        browser: browserTypes.LEVELING_LIST_RESULT_KEYS,
    },
    {
        name: 'LevelingActivitySummary',
        server: LEVELING_ACTIVITY_SUMMARY_KEYS,
        browser: browserTypes.LEVELING_ACTIVITY_SUMMARY_KEYS,
    },
    {
        name: 'LevelingActivityBucket',
        server: LEVELING_ACTIVITY_BUCKET_KEYS,
        browser: browserTypes.LEVELING_ACTIVITY_BUCKET_KEYS,
    },
    {
        name: 'LevelingActivityChart',
        server: LEVELING_ACTIVITY_CHART_KEYS,
        browser: browserTypes.LEVELING_ACTIVITY_CHART_KEYS,
    },
    {
        name: 'LevelingUserMetrics',
        server: LEVELING_USER_METRICS_KEYS,
        browser: browserTypes.LEVELING_USER_METRICS_KEYS,
    },
    {
        name: 'LevelingUserDetail',
        server: LEVELING_USER_DETAIL_KEYS,
        browser: browserTypes.LEVELING_USER_DETAIL_KEYS,
    },
] as const satisfies readonly { name: string; server: readonly string[]; browser: readonly string[] }[];

/**
 * The two closed vocabularies, gated as vocabularies rather than key lists.
 *
 * Separate rows because they fail differently from a shape: a member missing from a key
 * list is data the browser cannot read, whereas a value missing from one of these is a
 * value the browser cannot *type* — `?period=` is parsed server-side against its own copy,
 * so a period only one side knows about comes back silently downgraded, and an activity
 * status only the server emits renders as no badge at all.
 */
const VOCABULARIES = [
    { name: 'STATS_PERIODS', server: STATS_PERIODS, browser: browserTypes.STATS_PERIODS },
    {
        name: 'ACTIVITY_STATUSES',
        server: ACTIVITY_STATUSES,
        browser: browserTypes.ACTIVITY_STATUSES,
    },
] as const satisfies readonly { name: string; server: readonly string[]; browser: readonly string[] }[];

describe('leveling wire shape drift between server and browser', () => {
    it.each(SHAPES)('keeps $name identical on both sides', ({ name, server, browser }) => {
        const serverMembers = [...server].sort();
        const browserMembers = [...browser].sort();

        expect(
            browserMembers,
            `\`${name}\` has drifted. Server: [${serverMembers.join(', ')}]; browser ` +
                `(web/src/api/types.ts): [${browserMembers.join(', ')}]. A member the browser does not ` +
                `declare is one it is served and cannot read. ${REMEDY}`
        ).toEqual(serverMembers);
    });

    it.each(VOCABULARIES)('keeps the $name vocabulary identical on both sides', ({ name, server, browser }) => {
        const serverValues = [...server].sort();
        const browserValues = [...browser].sort();

        expect(
            browserValues,
            `${name} has drifted. Server: [${serverValues.join(', ')}]; browser ` +
                `(web/src/api/types.ts): [${browserValues.join(', ')}]. This union is closed on both ` +
                `sides, so widening one alone leaves the dashboard unable to type a value it is being ` +
                `sent. ${REMEDY}`
        ).toEqual(serverValues);
    });
});
