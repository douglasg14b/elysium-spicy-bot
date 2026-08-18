import {
    DEFAULT_VOICE_COOLDOWN_MS,
    DEFAULT_VOICE_MIN_ELIGIBLE_SECONDS,
    DEFAULT_VOICE_XP_ENABLED,
    DEFAULT_VOICE_XP_PER_MINUTE,
    VOICE_ELIGIBILITY_RULE,
} from '../constants';
import type { LevelingActivityEvent } from '../data/levelingActivityEventSchema';

export type VoiceXpSettings = {
    voiceXpPerMinute: number;
    voiceMinEligibleSeconds: number;
    voiceCooldownMs: number;
    voiceXpEnabled: boolean;
};

export type VoiceXpGrant = {
    xpAmount: number;
    eligibleSeconds: number;
};

export function getVoiceXpSettings(): VoiceXpSettings {
    return {
        voiceXpPerMinute: DEFAULT_VOICE_XP_PER_MINUTE,
        voiceMinEligibleSeconds: DEFAULT_VOICE_MIN_ELIGIBLE_SECONDS,
        voiceCooldownMs: DEFAULT_VOICE_COOLDOWN_MS,
        voiceXpEnabled: DEFAULT_VOICE_XP_ENABLED,
    };
}

export function calculateVoiceXpFromEligibleMs(
    eligibleMs: number,
    settings: VoiceXpSettings = getVoiceXpSettings()
): VoiceXpGrant {
    const eligibleSeconds = Math.max(0, Math.floor(eligibleMs / 1000));
    if (eligibleSeconds < settings.voiceMinEligibleSeconds) {
        return { xpAmount: 0, eligibleSeconds };
    }

    const eligibleMinutes = Math.floor(eligibleMs / 60_000);
    return {
        xpAmount: eligibleMinutes * settings.voiceXpPerMinute,
        eligibleSeconds,
    };
}

export function recalculateVoiceXpFromEvent(
    event: Pick<LevelingActivityEvent, 'activityType' | 'voiceEligibleSeconds'>,
    settings: VoiceXpSettings = getVoiceXpSettings()
): number {
    if (event.activityType !== 'voice') {
        return 0;
    }

    const eligibleSeconds = event.voiceEligibleSeconds ?? 0;
    return calculateVoiceXpFromEligibleMs(eligibleSeconds * 1000, settings).xpAmount;
}

/** Voice XP is optional relative to message/reaction logging — failures stay loud but contained. */
export function logIsolatedVoiceXpError(action: string, error: unknown): void {
    console.error(
        `[leveling] Voice XP ${action} failed. Message and reaction XP logging continues.`,
        error
    );
}

export { VOICE_ELIGIBILITY_RULE };
