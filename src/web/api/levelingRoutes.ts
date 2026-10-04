import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Guild } from 'discord.js';
import {
    loadGuildLevelRankings,
    loadLevelingInsights,
    loadUserLevelStats,
    levelingConfigRepo,
    parseStatsPeriod,
    type CohortProgressionPoint,
    type CohortSummary,
    type GuildLevelRankingEntry,
    type LevelingInsights,
    type LevelReachPoint,
    type UserLevelStats,
    type XpDistribution,
} from '../../features/leveling';
import { fetchMemberSnapshotsById } from '../../features/leveling/logic/fetchMemberSnapshots';
import type { GuildMemberSnapshot } from '../../features/leveling/logic/belowThresholdReport';
import type { AppEnv } from '../types';
import {
    LevelingInsightsBodySchema,
    LevelingListResultSchema,
    LevelingUserDetailSchema,
    type LevelingActivitySummary,
    type LevelingCohortProgressionPoint,
    type LevelingCohortSummary,
    type LevelingInsightsBody,
    type LevelingLevelReachPoint,
    type LevelingListResult,
    type LevelingMember,
    type LevelingRankingRow,
    type LevelingUserDetail,
    type LevelingXpDistribution,
} from './levelingBody';
import { apiRouter, errorBodyResponse, GUILD_SCOPED_ERRORS, GuildPathSchema, jsonResponse } from './openApi';

/**
 * Leveling: the guild leaderboard, one member's stats, and the guild-wide insights report.
 *
 * Read-only on purpose. Leveling's XP tuning has no write path in the repo, and five of
 * its columns are overwritten by `constants.ts` on every read, so a form offering them
 * would display a value the bot ignores and save one that never takes effect. Showing the
 * effective config and refusing to pretend it is editable is the honest surface; making it
 * editable is repo surgery plus a migration, and is deliberately not in this change.
 *
 * Adds no middleware: `requireAuth` + `requireGuildAccess` are applied once at the mount
 * site in `index.ts`, so `c.get('guild')` is already populated and already authorized. A
 * member's XP is moderator-facing data in a guild the caller already administers, which is
 * the existing tier rather than a second authorization concept.
 *
 * Described by the OpenAPI spec: each route's `createRoute` definition is its contract,
 * the shapes are `levelingBody.ts`'s, and the dashboard's SDK is generated from them.
 */

/**
 * Rows returned by the leaderboard before it admits to truncating.
 *
 * Distinct from — and below — `loadGuildLevelRankings`'s own 500-row scan ceiling, which
 * exists to stop a backlog of departed members looping. Asking for 100 keeps the read well
 * inside that, so `truncated` here means "there are more ranked members", not "the scan
 * gave up".
 */
export const LEVELING_LIST_CAP = 100;

/**
 * The member page's path. The user id is checked in the handler rather than here, because
 * its refusal names the value it was given — a sentence no schema can carry into the spec.
 */
const LevelingUserPathSchema = GuildPathSchema.extend({
    userId: z.string(),
});

/**
 * The member page's window. A plain string, parsed by `parseStatsPeriod` in the handler:
 * the period is a view preference with a sensible default, so an unrecognised one degrades
 * to the default rather than refusing to show the member at all.
 */
const LevelingUserQuerySchema = z.object({
    period: z.string().optional().openapi({
        description: 'A `StatsPeriod`. Absent or unrecognised means the bot’s default window.',
    }),
});

const listLevelingRoute = createRoute({
    method: 'get',
    path: '/{guildId}/leveling',
    operationId: 'listLeveling',
    tags: ['leveling'],
    summary: 'The guild leaderboard, ranked by XP',
    request: { params: GuildPathSchema },
    responses: {
        200: jsonResponse('The leaderboard, capped — read `truncated` before believing the length.', LevelingListResultSchema),
        ...GUILD_SCOPED_ERRORS,
    },
});

const getLevelingUserRoute = createRoute({
    method: 'get',
    path: '/{guildId}/leveling/users/{userId}',
    operationId: 'getLevelingUser',
    tags: ['leveling'],
    summary: "One member's level, XP and activity",
    request: { params: LevelingUserPathSchema, query: LevelingUserQuerySchema },
    responses: {
        200: jsonResponse('The member’s stats, over the window in `statsPeriod`.', LevelingUserDetailSchema),
        ...GUILD_SCOPED_ERRORS,
        400: errorBodyResponse('The user id is not a Discord user id, or the server id is missing.'),
    },
});

const getLevelingInsightsRoute = createRoute({
    method: 'get',
    path: '/{guildId}/leveling/insights',
    operationId: 'getLevelingInsights',
    tags: ['leveling'],
    summary: 'The guild-wide insights report',
    request: { params: GuildPathSchema },
    responses: {
        200: jsonResponse('The report, and how fresh it is.', LevelingInsightsBodySchema),
        ...GUILD_SCOPED_ERRORS,
        503: errorBodyResponse(
            'The guild has more logged XP events than the report will scan. Nothing is broken; the sentence ' +
                'names the count and the ceiling.'
        ),
    },
});

export function levelingRoutes(): OpenAPIHono<AppEnv> {
    return apiRouter((router) => {
        router.openapi(listLevelingRoute, async (c) => {
            const guild = c.get('guild');

            /*
             * The cap plus one, so a full page can be distinguished from an overflowing one
             * without a second count query. `totalRankedMembers` comes back from the loader
             * regardless and is the guild-wide figure, so the footer strip does not move when
             * the list is capped.
             */
            const rankings = await loadGuildLevelRankings({
                guildId: guild.id,
                limit: LEVELING_LIST_CAP + 1,
            });

            const truncated = rankings.entries.length > LEVELING_LIST_CAP;
            const entries = truncated ? rankings.entries.slice(0, LEVELING_LIST_CAP) : rankings.entries;

            const members = await fetchMemberSnapshotsById(
                guild,
                entries.map((entry) => entry.userId)
            );

            const config = await levelingConfigRepo.getByGuildId(guild.id);

            const body: LevelingListResult = {
                entries: entries.map((entry) => rankingRow(entry, members)),
                totalRankedMembers: rankings.totalRankedMembers,
                truncated,
                enabled: !!config?.enabled,
            };

            return c.json(body, 200);
        });

        router.openapi(getLevelingUserRoute, async (c) => {
            const guild = c.get('guild');

            const resolved = resolveUserId(c.req.valid('param').userId);
            if (!resolved.ok) {
                return c.json({ error: resolved.error }, resolved.status);
            }

            const period = parseStatsPeriod(c.req.valid('query').period ?? null);
            const stats = await loadUserLevelStats(guild.id, resolved.userId, { period });

            /*
             * A member with no progress row is level 1 with nothing recorded rather than a 404:
             * `loadUserLevelStats` answers for anyone, and "this member has earned nothing yet"
             * is a real answer an operator asked for. A 404 here would be reserved for a
             * malformed id, which `resolveUserId` already rejects with a 400.
             */
            const member = await memberSnapshot(guild, resolved.userId);

            const body: LevelingUserDetail = userDetail(stats, member);
            return c.json(body, 200);
        });

        router.openapi(getLevelingInsightsRoute, async (c) => {
            const guild = c.get('guild');

            const result = await loadLevelingInsights(guild.id);

            if (!result.ok) {
                /*
                 * 503 rather than 400 or 500: nothing about the request is malformed and nothing
                 * is broken — the guild's history is simply too large to scan without stalling
                 * the bot, which is a capacity answer and the one status that says "try later".
                 * The count and the ceiling are both named because "too big" without a number
                 * gives an operator nothing to act on.
                 */
                return c.json(
                    {
                        error:
                            `This guild has ${result.eventCount.toLocaleString('en-US')} logged XP events, ` +
                            `over the ${result.ceiling.toLocaleString('en-US')} ceiling the insights report ` +
                            `will scan. Crunching that would lock the bot up for everyone, so it is sitting ` +
                            `this one out.`,
                    },
                    503
                );
            }

            const body: LevelingInsightsBody = insightsBody(result.insights, result.computedAt, result.cached);
            return c.json(body, 200);
        });
    });
}

/* ---- Helpers ---- */

type ResolveUserIdResult =
    | { ok: true; userId: string }
    | { ok: false; error: string; status: 400 };

/**
 * Parse the path's user id before it can reach a query.
 *
 * A snowflake, so a length and digit check rather than `Number()` — the value exceeds
 * `Number.MAX_SAFE_INTEGER` and parsing it would corrupt the id it is meant to validate.
 * Unlike a ticket there is no cross-guild concern to hide: progress is looked up by
 * `(guildId, userId)` together, so another guild's row is unreachable by construction and
 * an unknown id simply has no activity.
 */
function resolveUserId(rawId: string): ResolveUserIdResult {
    if (!/^\d{17,20}$/.test(rawId)) {
        return { ok: false, error: `\`${rawId}\` is not a user id.`, status: 400 };
    }

    return { ok: true, userId: rawId };
}

async function memberSnapshot(guild: Guild, userId: string): Promise<LevelingMember | null> {
    const found = await fetchMemberSnapshotsById(guild, [userId]);
    const snapshot = found.get(userId);

    return snapshot ? { ...snapshot } : null;
}

function rankingRow(
    entry: GuildLevelRankingEntry,
    members: Map<string, GuildMemberSnapshot>
): LevelingRankingRow {
    const member = members.get(entry.userId);

    return {
        rank: entry.rank,
        userId: entry.userId,
        // Null rather than a placeholder string: a departed member still holds XP, and the
        // browser decides how to say "no longer here" rather than parsing a sentinel.
        member: member
            ? {
                  userId: entry.userId,
                  displayName: member.displayName,
                  username: member.username,
                  avatarUrl: member.avatarUrl,
                  isBot: member.isBot,
              }
            : null,
        level: entry.level,
        totalXp: entry.totalXp,
        messageCount: entry.messageCount,
        reactionCount: entry.reactionCount,
        photoUploadCount: entry.photoUploadCount,
        lastActiveAt: entry.lastActiveAt ? entry.lastActiveAt.toISOString() : null,
    };
}

function userDetail(stats: UserLevelStats, member: LevelingMember | null): LevelingUserDetail {
    const { profile, progress, metrics, activityChart, statsPeriod } = stats;

    return {
        userId: profile.userId,
        member,
        level: profile.level,
        totalXp: profile.totalXp,
        xpWithinLevel: profile.xpWithinLevel,
        xpToNextLevel: profile.xpToNextLevel,
        xpForCurrentLevelStep: profile.xpForCurrentLevelStep,
        hasAnyActivity: profile.hasAnyActivity,
        statsPeriod,
        recentPeriodDays: profile.recentPeriodDays,
        recentActivity: totals(profile.recentActivity),
        totalActivity: totals(profile.totalActivity),
        voiceSessionCount: progress?.voiceSessionCount ?? 0,
        totalVoiceSeconds: progress?.totalVoiceSeconds ?? 0,
        activityChart: {
            granularity: activityChart.granularity,
            buckets: activityChart.buckets.map((bucket) => ({
                activityDate: bucket.activityDate,
                messageCount: bucket.messageCount,
                reactionCount: bucket.reactionCount,
                photoUploadCount: bucket.photoUploadCount,
                voiceSessionCount: bucket.voiceSessionCount,
            })),
        },
        metrics: {
            activityStatus: metrics.activityStatus,
            // ISO at the boundary: `Date` does not survive JSON as a `Date`, and leaving it
            // to `JSON.stringify` would put an implicit format on the wire that the
            // schema claims is a `string` without anything making it one.
            lastActiveAt: metrics.lastActiveAt ? metrics.lastActiveAt.toISOString() : null,
            memberSince: metrics.memberSince ? metrics.memberSince.toISOString() : null,
            tenureDays: metrics.tenureDays,
            recentMsgsPerDay: metrics.recentMsgsPerDay,
            recentXpPerDay: metrics.recentXpPerDay,
            allTimeMsgsPerDay: metrics.allTimeMsgsPerDay,
            messageSharePercent: metrics.messageSharePercent,
            reactionSharePercent: metrics.reactionSharePercent,
            voiceSharePercent: metrics.voiceSharePercent,
            photoRatePercent: metrics.photoRatePercent,
            avgMessageLengthRecent: metrics.avgMessageLengthRecent,
            avgXpPerMessageRecent: metrics.avgXpPerMessageRecent,
            dailyPeakEvents: metrics.dailyPeakEvents,
        },
    };
}

function totals(source: {
    messageCount: number;
    reactionCount: number;
    photoUploadCount: number;
    voiceSessionCount: number;
    totalXp: number;
    eventCount: number;
}): LevelingActivitySummary {
    return {
        messageCount: source.messageCount,
        reactionCount: source.reactionCount,
        photoUploadCount: source.photoUploadCount,
        voiceSessionCount: source.voiceSessionCount,
        totalXp: source.totalXp,
        eventCount: source.eventCount,
    };
}

function levelReachPoint(point: LevelReachPoint): LevelingLevelReachPoint {
    return {
        level: point.level,
        membersReached: point.membersReached,
        percentReached: point.percentReached,
    };
}

function cohortProgressionPoint(point: CohortProgressionPoint): LevelingCohortProgressionPoint {
    return {
        level: point.level,
        medianDays: point.medianDays,
        membersReached: point.membersReached,
        thin: point.thin,
    };
}

function cohortSummary(cohort: CohortSummary): LevelingCohortSummary {
    return {
        cohort: cohort.cohort,
        memberCount: cohort.memberCount,
        medianTotalXp: cohort.medianTotalXp,
        medianLevel: cohort.medianLevel,
        medianActiveDays: cohort.medianActiveDays,
        progression: cohort.progression.map(cohortProgressionPoint),
    };
}

function xpDistribution(distribution: XpDistribution): LevelingXpDistribution {
    return {
        typicalXp: distribution.typicalXp,
        meanXp: distribution.meanXp,
        meanToTypicalRatio: distribution.meanToTypicalRatio,
        topMemberXp: distribution.topMemberXp,
        deciles: [...distribution.deciles],
    };
}

/**
 * The report, plus how fresh it is.
 *
 * `readonly` arrays are copied rather than passed through: the wire shapes are mutable
 * by the convention of `levelingBody.ts`, and the cache hands out the *same* object to every caller
 * of `loadLevelingInsights` within the TTL, so aliasing its arrays into a response body
 * would let a later mutation rewrite what the next hit serves.
 *
 * Exported for its test. Through the route this is unobservable — `c.json` serializes
 * immediately, so the JSON a test reads back is a copy whatever this function does, and a
 * test asserting it via HTTP passes with every copy removed. The invariant is only
 * reachable on the returned object, so that is where it is asserted.
 */
export function insightsBody(
    insights: LevelingInsights,
    computedAt: Date,
    cached: boolean
): LevelingInsightsBody {
    return {
        trackedMembers: insights.trackedMembers,
        topLevel: insights.topLevel,
        levelReachTruncated: insights.levelReachTruncated,
        levelReach: insights.levelReach.map(levelReachPoint),
        cohorts: insights.cohorts.map(cohortSummary),
        xpDistribution: insights.xpDistribution ? xpDistribution(insights.xpDistribution) : null,
        firstActivityDate: insights.firstActivityDate,
        lastActivityDate: insights.lastActivityDate,
        // ISO at the boundary, for the same reason `lastActiveAt` is converted above: the
        // schema claims `string`, and only this call makes that true.
        computedAt: computedAt.toISOString(),
        cached,
    };
}
