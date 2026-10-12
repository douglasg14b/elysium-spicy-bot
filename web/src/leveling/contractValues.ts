/**
 * The leveling vocabularies the pages need as values, read off the generated zod rather
 * than restated: the period picker's options, every activity status, every cohort.
 *
 * Each is the enum the route declares in `src/web/api/levelingBody.ts`, in the server's
 * order — the picker offers periods shortest first and the chart legend lists cohorts
 * least to most active — so a server that widens one is a browser that has it after
 * `pnpm sdk:generate`. `src/web/api/__tests__/contractValues.test.ts` holds each to the
 * server's list.
 */

import { zActivityStatus, zCohortKey, zStatsPeriod } from '@brattybot/web-sdk';

/** The windows a member's stats can cover, shortest first. */
export const STATS_PERIODS = zStatsPeriod.options;

/** How recently a member can have been active. */
export const ACTIVITY_STATUSES = zActivityStatus.options;

/** The insights report's cohorts, least to most active. */
export const COHORT_KEYS = zCohortKey.options;
