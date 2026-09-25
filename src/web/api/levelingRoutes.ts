import { Hono } from 'hono';
import type { Guild } from 'discord.js';
import {
    loadGuildLevelRankings,
    loadUserLevelStats,
    levelingConfigRepo,
    parseStatsPeriod,
    type ActivityStatus,
    type GuildLevelRankingEntry,
    type StatsPeriod,
    type UserLevelStats,
} from '../../features/leveling';
import { fetchMemberSnapshotsById } from '../../features/leveling/logic/fetchMemberSnapshots';
import type { GuildMemberSnapshot } from '../../features/leveling/logic/belowThresholdReport';
import type { AppEnv } from '../types';

/**
 * Leveling: the guild leaderboard and one member's stats.
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

export function levelingRoutes(): Hono<AppEnv> {
    const app = new Hono<AppEnv>();

    app.get('/:guildId/leveling', async (c) => {
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

        return c.json(body);
    });

    app.get('/:guildId/leveling/users/:userId', async (c) => {
        const guild = c.get('guild');

        const resolved = resolveUserId(c.req.param('userId'));
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status);
        }

        const period = parseStatsPeriod(c.req.query('period') ?? null);
        const stats = await loadUserLevelStats(guild.id, resolved.userId, { period });

        /*
         * A member with no progress row is level 1 with nothing recorded rather than a 404:
         * `loadUserLevelStats` answers for anyone, and "this member has earned nothing yet"
         * is a real answer an operator asked for. A 404 here would be reserved for a
         * malformed id, which `resolveUserId` already rejects with a 400.
         */
        const member = await memberSnapshot(guild, resolved.userId);

        const body: LevelingUserDetail = userDetail(stats, member);
        return c.json(body);
    });

    return app;
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
            // mirrored type claims is a `string` without anything making it one.
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

/* ---- Wire shapes ---- */

export interface LevelingMember {
    userId: string;
    displayName: string;
    username: string;
    /** Null when the account has no avatar, so the browser renders its own fallback. */
    avatarUrl: string | null;
    isBot: boolean;
}

export interface LevelingRankingRow {
    rank: number;
    userId: string;
    /** Null when the member has left the guild but still holds progress. */
    member: LevelingMember | null;
    level: number;
    totalXp: number;
    messageCount: number;
    reactionCount: number;
    photoUploadCount: number;
    lastActiveAt: string | null;
}

export interface LevelingListResult {
    entries: LevelingRankingRow[];
    totalRankedMembers: number;
    truncated: boolean;
    /** Whether the guild has leveling switched on at all. */
    enabled: boolean;
}

export interface LevelingActivitySummary {
    messageCount: number;
    reactionCount: number;
    photoUploadCount: number;
    voiceSessionCount: number;
    totalXp: number;
    eventCount: number;
}

export interface LevelingActivityBucket {
    activityDate: string;
    messageCount: number;
    reactionCount: number;
    photoUploadCount: number;
    voiceSessionCount: number;
}

export interface LevelingActivityChart {
    granularity: 'daily' | 'weekly';
    buckets: LevelingActivityBucket[];
}

export interface LevelingUserMetrics {
    activityStatus: ActivityStatus;
    lastActiveAt: string | null;
    memberSince: string | null;
    tenureDays: number;
    recentMsgsPerDay: number;
    recentXpPerDay: number;
    allTimeMsgsPerDay: number;
    messageSharePercent: number;
    reactionSharePercent: number;
    voiceSharePercent: number;
    photoRatePercent: number;
    avgMessageLengthRecent: number | null;
    avgXpPerMessageRecent: number | null;
    dailyPeakEvents: number;
}

export interface LevelingUserDetail {
    userId: string;
    member: LevelingMember | null;
    level: number;
    totalXp: number;
    xpWithinLevel: number;
    xpToNextLevel: number;
    xpForCurrentLevelStep: number;
    hasAnyActivity: boolean;
    statsPeriod: StatsPeriod;
    recentPeriodDays: number;
    recentActivity: LevelingActivitySummary;
    totalActivity: LevelingActivitySummary;
    voiceSessionCount: number;
    totalVoiceSeconds: number;
    activityChart: LevelingActivityChart;
    metrics: LevelingUserMetrics;
}

/* ---- Drift gate ---- */

/*
 * The wire shapes above exist twice: here, and by hand in `web/src/api/types.ts`. A single
 * `import type` from `src/` into `web/src/` pulls the bot tree into the browser project's
 * compilation and breaks `pnpm build:web`, so the mirror is necessary and the gate is what
 * keeps it honest.
 *
 * Nested shapes are gated **separately**, not just by name. Gating `metrics` as one key
 * left an earlier version of this pattern with the members inside it completely unchecked —
 * a thirteenth metric could be added and every drift test stayed green.
 */
export const LEVELING_MEMBER_KEYS = [
    'userId',
    'displayName',
    'username',
    'avatarUrl',
    'isBot',
] as const satisfies readonly (keyof LevelingMember)[];

export const LEVELING_RANKING_ROW_KEYS = [
    'rank',
    'userId',
    'member',
    'level',
    'totalXp',
    'messageCount',
    'reactionCount',
    'photoUploadCount',
    'lastActiveAt',
] as const satisfies readonly (keyof LevelingRankingRow)[];

export const LEVELING_LIST_RESULT_KEYS = [
    'entries',
    'totalRankedMembers',
    'truncated',
    'enabled',
] as const satisfies readonly (keyof LevelingListResult)[];

export const LEVELING_ACTIVITY_SUMMARY_KEYS = [
    'messageCount',
    'reactionCount',
    'photoUploadCount',
    'voiceSessionCount',
    'totalXp',
    'eventCount',
] as const satisfies readonly (keyof LevelingActivitySummary)[];

export const LEVELING_ACTIVITY_BUCKET_KEYS = [
    'activityDate',
    'messageCount',
    'reactionCount',
    'photoUploadCount',
    'voiceSessionCount',
] as const satisfies readonly (keyof LevelingActivityBucket)[];

export const LEVELING_ACTIVITY_CHART_KEYS = [
    'granularity',
    'buckets',
] as const satisfies readonly (keyof LevelingActivityChart)[];

export const LEVELING_USER_METRICS_KEYS = [
    'activityStatus',
    'lastActiveAt',
    'memberSince',
    'tenureDays',
    'recentMsgsPerDay',
    'recentXpPerDay',
    'allTimeMsgsPerDay',
    'messageSharePercent',
    'reactionSharePercent',
    'voiceSharePercent',
    'photoRatePercent',
    'avgMessageLengthRecent',
    'avgXpPerMessageRecent',
    'dailyPeakEvents',
] as const satisfies readonly (keyof LevelingUserMetrics)[];

export const LEVELING_USER_DETAIL_KEYS = [
    'userId',
    'member',
    'level',
    'totalXp',
    'xpWithinLevel',
    'xpToNextLevel',
    'xpForCurrentLevelStep',
    'hasAnyActivity',
    'statsPeriod',
    'recentPeriodDays',
    'recentActivity',
    'totalActivity',
    'voiceSessionCount',
    'totalVoiceSeconds',
    'activityChart',
    'metrics',
] as const satisfies readonly (keyof LevelingUserDetail)[];

/*
 * No re-export of `STATS_PERIODS` / `ACTIVITY_STATUSES` here on purpose.
 *
 * An alias would read as convenience for the drift test, but it would make that test
 * depend on this file still choosing to forward a constant it never otherwise uses:
 * deleting the alias as dead code would break the gate at import and report a missing
 * export rather than a vocabulary drift. The test reads the owning modules instead.
 */

/**
 * Do not delete as unused: removing this erases the guards above.
 *
 * `satisfies` rejects a name that is not a member; this rejects a member missing from the
 * list, which is the direction that actually rots. The tuple wrapper is load-bearing — a
 * bare `KeyListsComplete extends never` distributes over the union and is vacuously true
 * for an empty one, so it would pass whatever the lists said.
 */
type KeyListsComplete =
    | Exclude<keyof LevelingMember, (typeof LEVELING_MEMBER_KEYS)[number]>
    | Exclude<keyof LevelingRankingRow, (typeof LEVELING_RANKING_ROW_KEYS)[number]>
    | Exclude<keyof LevelingListResult, (typeof LEVELING_LIST_RESULT_KEYS)[number]>
    | Exclude<keyof LevelingActivitySummary, (typeof LEVELING_ACTIVITY_SUMMARY_KEYS)[number]>
    | Exclude<keyof LevelingActivityBucket, (typeof LEVELING_ACTIVITY_BUCKET_KEYS)[number]>
    | Exclude<keyof LevelingActivityChart, (typeof LEVELING_ACTIVITY_CHART_KEYS)[number]>
    | Exclude<keyof LevelingUserMetrics, (typeof LEVELING_USER_METRICS_KEYS)[number]>
    | Exclude<keyof LevelingUserDetail, (typeof LEVELING_USER_DETAIL_KEYS)[number]>;

const keyListsAreComplete: [KeyListsComplete] extends [never]
    ? true
    : ['A leveling wire-shape key list is missing a member', KeyListsComplete] = true;

void keyListsAreComplete;
