import type { LevelingProgress } from '../data/levelingProgressSchema';
import { getTotalXpForLevel } from './xpCalculator';

export const BELOW_THRESHOLD_CARD_ROW_LIMIT = 10;

export type BelowThresholdScope = 'current' | 'tracked';

export type BelowThresholdFilter = {
    level: number | null;
    xp: number | null;
    scope: BelowThresholdScope;
};

export type GuildMemberSnapshot = {
    userId: string;
    displayName: string;
    username: string;
    isBot: boolean;
    avatarUrl: string | null;
};

export type BelowThresholdReportEntry = {
    userId: string;
    displayName: string;
    username: string;
    avatarUrl: string | null;
    totalXp: number;
    level: number;
    messageCount: number;
    reactionCount: number;
    photoUploadCount: number;
    lastActiveAt: Date | null;
    xpToThreshold: number;
    tracked: boolean;
};

export type BelowThresholdReport = {
    filter: BelowThresholdFilter;
    entries: BelowThresholdReportEntry[];
    cardEntries: BelowThresholdReportEntry[];
    totalConsidered: number;
};

export type ParseBelowThresholdFilterInput = {
    level: number | null;
    xp: number | null;
    scope: string | null;
};

export type ParseBelowThresholdFilterResult =
    | { ok: true; filter: BelowThresholdFilter }
    | { ok: false; message: string };

const EMPTY_PROGRESS = {
    totalXp: 0,
    level: 1,
    messageCount: 0,
    reactionCount: 0,
    photoUploadCount: 0,
    lastMessageXpAt: null,
    lastReactionXpAt: null,
    lastVoiceXpAt: null,
} as const;

/**
 * Parse slash-command options into a below-threshold filter.
 * Requires at least one of `level` or `xp`.
 */
export function parseBelowThresholdFilter(
    input: ParseBelowThresholdFilterInput
): ParseBelowThresholdFilterResult {
    if (input.level == null && input.xp == null) {
        return {
            ok: false,
            message: 'Pick a level, an XP amount, or both.',
        };
    }

    const scope = input.scope ?? 'current';
    if (scope !== 'current' && scope !== 'tracked') {
        return {
            ok: false,
            message: 'Scope must be current members or tracked members.',
        };
    }

    return {
        ok: true,
        filter: {
            level: input.level,
            xp: input.xp,
            scope,
        },
    };
}

export function isBelowThreshold(
    level: number,
    totalXp: number,
    filter: Pick<BelowThresholdFilter, 'level' | 'xp'>
): boolean {
    if (filter.level == null && filter.xp == null) {
        return false;
    }

    if (filter.level != null && level >= filter.level) {
        return false;
    }

    if (filter.xp != null && totalXp >= filter.xp) {
        return false;
    }

    return true;
}

/**
 * XP still needed to clear every set bar. When both level and XP are set,
 * the member must reach both, so this is the larger of the two remainders.
 */
export function getXpToThreshold(
    totalXp: number,
    filter: Pick<BelowThresholdFilter, 'level' | 'xp'>
): number {
    const remainders: number[] = [];

    if (filter.level != null) {
        remainders.push(Math.max(0, getTotalXpForLevel(filter.level) - totalXp));
    }

    if (filter.xp != null) {
        remainders.push(Math.max(0, filter.xp - totalXp));
    }

    if (remainders.length === 0) {
        return 0;
    }

    return Math.max(...remainders);
}

export function formatThresholdLabel(filter: Pick<BelowThresholdFilter, 'level' | 'xp'>): string {
    const parts: string[] = [];

    if (filter.level != null) {
        parts.push(`level ${filter.level}`);
    }

    if (filter.xp != null) {
        parts.push(`${filter.xp.toLocaleString('en-US')} XP`);
    }

    if (parts.length === 0) {
        return 'the threshold';
    }

    return `below ${parts.join(' and ')}`;
}

/**
 * Build the below-threshold member list from guild snapshots and stored progress.
 * `current` includes members with no progress row (treated as level 1 / 0 XP).
 * `tracked` only includes members who already have a progress row.
 */
export function buildBelowThresholdReport(input: {
    filter: BelowThresholdFilter;
    members: readonly GuildMemberSnapshot[];
    progressRows: readonly LevelingProgress[];
}): BelowThresholdReport {
    const progressByUserId = new Map(input.progressRows.map((row) => [row.userId, row]));
    const humanMembers = input.members.filter((member) => !member.isBot);
    const candidates =
        input.filter.scope === 'tracked'
            ? humanMembers.filter((member) => progressByUserId.has(member.userId))
            : humanMembers;

    const entries = candidates
        .map((member) => {
            const progress = progressByUserId.get(member.userId);
            const totals = progress ?? EMPTY_PROGRESS;

            return {
                userId: member.userId,
                displayName: member.displayName,
                username: member.username,
                avatarUrl: member.avatarUrl,
                totalXp: totals.totalXp,
                level: totals.level,
                messageCount: totals.messageCount,
                reactionCount: totals.reactionCount,
                photoUploadCount: totals.photoUploadCount,
                lastActiveAt: getLastActiveAt(totals.lastMessageXpAt, totals.lastReactionXpAt, totals.lastVoiceXpAt),
                xpToThreshold: getXpToThreshold(totals.totalXp, input.filter),
                tracked: progress != null,
            } satisfies BelowThresholdReportEntry;
        })
        .filter((entry) => isBelowThreshold(entry.level, entry.totalXp, input.filter))
        .sort(compareClosestToThreshold);

    return {
        filter: input.filter,
        entries,
        cardEntries: entries.slice(0, BELOW_THRESHOLD_CARD_ROW_LIMIT),
        totalConsidered: candidates.length,
    };
}

export function formatBelowThresholdCsv(report: BelowThresholdReport): string {
    const header = [
        'userId',
        'displayName',
        'username',
        'level',
        'totalXp',
        'xpToThreshold',
        'messageCount',
        'reactionCount',
        'photoUploadCount',
        'lastActiveAt',
        'tracked',
    ].join(',');

    const rows = report.entries.map((entry) =>
        [
            csvField(entry.userId),
            csvField(entry.displayName),
            csvField(entry.username),
            csvField(entry.level),
            csvField(entry.totalXp),
            csvField(entry.xpToThreshold),
            csvField(entry.messageCount),
            csvField(entry.reactionCount),
            csvField(entry.photoUploadCount),
            csvField(entry.lastActiveAt?.toISOString() ?? ''),
            csvField(entry.tracked ? 'true' : 'false'),
        ].join(',')
    );

    return [header, ...rows].join('\n');
}

export function formatBelowThresholdReply(report: BelowThresholdReport): string {
    const threshold = formatThresholdLabel(report.filter);
    const scopeLabel = report.filter.scope === 'current' ? 'current members' : 'tracked members';

    if (report.entries.length === 0) {
        return `Nobody is ${threshold} among ${scopeLabel}.`;
    }

    const shown = report.cardEntries.length;
    const extra =
        report.entries.length > shown
            ? ` Card shows the ${shown} closest. Full list is in the CSV.`
            : '';

    return `${formatCount(report.entries.length)} of ${formatCount(report.totalConsidered)} ${scopeLabel} are ${threshold}.${extra}`;
}

function compareClosestToThreshold(
    left: BelowThresholdReportEntry,
    right: BelowThresholdReportEntry
): number {
    if (left.xpToThreshold !== right.xpToThreshold) {
        return left.xpToThreshold - right.xpToThreshold;
    }

    if (left.totalXp !== right.totalXp) {
        return right.totalXp - left.totalXp;
    }

    return left.displayName.localeCompare(right.displayName);
}

function getLastActiveAt(
    lastMessageXpAt: Date | string | null,
    lastReactionXpAt: Date | string | null,
    lastVoiceXpAt?: Date | string | null
): Date | null {
    const timestamps = [lastMessageXpAt, lastReactionXpAt, lastVoiceXpAt]
        .filter((value): value is Date | string => value != null)
        .map((value) => (value instanceof Date ? value : new Date(value)));

    if (timestamps.length === 0) {
        return null;
    }

    return new Date(Math.max(...timestamps.map((date) => date.getTime())));
}

function csvField(value: string | number): string {
    const text = String(value);
    if (/[",\n\r]/.test(text)) {
        return `"${text.replaceAll('"', '""')}"`;
    }

    return text;
}

function formatCount(value: number): string {
    return value.toLocaleString('en-US');
}
