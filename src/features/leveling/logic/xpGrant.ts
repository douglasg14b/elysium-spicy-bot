import { isCooldownActive, toActivityDate } from './activityFilters';
import type { LevelingProgress } from '../data/levelingProgressSchema';

export type XpActivityType = 'message' | 'reaction' | 'voice';

export type XpGrantComputation = {
    previousTotalXp: number;
    newTotalXp: number;
    messageCount: number;
    reactionCount: number;
    photoUploadCount: number;
    voiceSessionCount: number;
    totalVoiceSeconds: number;
    lastMessageXpAt: Date | null;
    lastReactionXpAt: Date | null;
    lastVoiceXpAt: Date | null;
};

type ExistingProgressSnapshot = Pick<
    LevelingProgress,
    'totalXp' | 'messageCount' | 'reactionCount' | 'photoUploadCount' | 'lastMessageXpAt' | 'lastReactionXpAt'
> &
    Partial<Pick<LevelingProgress, 'voiceSessionCount' | 'totalVoiceSeconds' | 'lastVoiceXpAt'>>;

export function computeXpGrant(input: {
    existing: ExistingProgressSnapshot | null;
    xpAmount: number;
    activityType: XpActivityType;
    cooldownMs: number;
    grantedAt: Date;
    incrementMessageCount?: boolean;
    incrementReactionCount?: boolean;
    incrementPhotoUploadCount?: boolean;
    incrementVoiceSessionCount?: boolean;
    addVoiceSeconds?: number;
}): XpGrantComputation | null {
    if (input.existing) {
        const lastActivityAt = getLastActivityAt(input.existing, input.activityType);
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
        voiceSessionCount: (input.existing?.voiceSessionCount ?? 0) + (input.incrementVoiceSessionCount ? 1 : 0),
        totalVoiceSeconds: (input.existing?.totalVoiceSeconds ?? 0) + (input.addVoiceSeconds ?? 0),
        lastMessageXpAt:
            input.activityType === 'message'
                ? input.grantedAt
                : toActivityDate(input.existing?.lastMessageXpAt ?? null),
        lastReactionXpAt:
            input.activityType === 'reaction'
                ? input.grantedAt
                : toActivityDate(input.existing?.lastReactionXpAt ?? null),
        lastVoiceXpAt:
            input.activityType === 'voice'
                ? input.grantedAt
                : toActivityDate(input.existing?.lastVoiceXpAt ?? null),
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

function getLastActivityAt(
    existing: ExistingProgressSnapshot,
    activityType: XpActivityType
): Date | string | null | undefined {
    switch (activityType) {
        case 'message':
            return existing.lastMessageXpAt;
        case 'reaction':
            return existing.lastReactionXpAt;
        case 'voice':
            return existing.lastVoiceXpAt ?? null;
    }
}
