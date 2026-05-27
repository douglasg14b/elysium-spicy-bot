import { isCooldownActive, toActivityDate } from './activityFilters';
import type { LevelingProgress } from '../data/levelingProgressSchema';

export type XpActivityType = 'message' | 'reaction';

export type XpGrantComputation = {
    previousTotalXp: number;
    newTotalXp: number;
    messageCount: number;
    reactionCount: number;
    photoUploadCount: number;
    lastMessageXpAt: Date | null;
    lastReactionXpAt: Date | null;
};

type ExistingProgressSnapshot = Pick<
    LevelingProgress,
    'totalXp' | 'messageCount' | 'reactionCount' | 'photoUploadCount' | 'lastMessageXpAt' | 'lastReactionXpAt'
>;

export function computeXpGrant(input: {
    existing: ExistingProgressSnapshot | null;
    xpAmount: number;
    activityType: XpActivityType;
    cooldownMs: number;
    grantedAt: Date;
    incrementMessageCount?: boolean;
    incrementReactionCount?: boolean;
    incrementPhotoUploadCount?: boolean;
}): XpGrantComputation | null {
    if (input.existing) {
        const lastActivityAt =
            input.activityType === 'message' ? input.existing.lastMessageXpAt : input.existing.lastReactionXpAt;

        if (isCooldownActive(toActivityDate(lastActivityAt), input.cooldownMs, input.grantedAt)) {
            return null;
        }
    }

    const previousTotalXp = input.existing?.totalXp ?? 0;

    return {
        previousTotalXp,
        newTotalXp: previousTotalXp + input.xpAmount,
        messageCount: (input.existing?.messageCount ?? 0) + (input.incrementMessageCount ? 1 : 0),
        reactionCount: (input.existing?.reactionCount ?? 0) + (input.incrementReactionCount ? 1 : 0),
        photoUploadCount: (input.existing?.photoUploadCount ?? 0) + (input.incrementPhotoUploadCount ? 1 : 0),
        lastMessageXpAt:
            input.activityType === 'message'
                ? input.grantedAt
                : toActivityDate(input.existing?.lastMessageXpAt ?? null),
        lastReactionXpAt:
            input.activityType === 'reaction'
                ? input.grantedAt
                : toActivityDate(input.existing?.lastReactionXpAt ?? null),
    };
}

export function toTimestampValue(value: Date | null): string | null {
    return value ? value.toISOString() : null;
}

/** Activity is always logged; cooldown-blocked grants store 0 XP on the event row. */
export function getRecordedActivityXpAmount(
    computation: XpGrantComputation | null,
    requestedXpAmount: number
): number {
    return computation ? requestedXpAmount : 0;
}
