import { describe, expect, it } from 'vitest';
import {
    calculateVoiceXpFromEligibleMs,
    getVoiceXpSettings,
    recalculateVoiceXpFromEvent,
} from '../logic/voiceXp';
import { DEFAULT_VOICE_MIN_ELIGIBLE_SECONDS, DEFAULT_VOICE_XP_PER_MINUTE } from '../constants';

describe('voiceXp', () => {
    it('floors to whole eligible minutes', () => {
        expect(calculateVoiceXpFromEligibleMs(119_999)).toEqual({
            xpAmount: DEFAULT_VOICE_XP_PER_MINUTE,
            eligibleSeconds: 119,
        });
        expect(calculateVoiceXpFromEligibleMs(180_000)).toEqual({
            xpAmount: DEFAULT_VOICE_XP_PER_MINUTE * 3,
            eligibleSeconds: 180,
        });
    });

    it('returns zero XP below the minimum eligible duration', () => {
        expect(calculateVoiceXpFromEligibleMs((DEFAULT_VOICE_MIN_ELIGIBLE_SECONDS - 1) * 1000)).toEqual({
            xpAmount: 0,
            eligibleSeconds: DEFAULT_VOICE_MIN_ELIGIBLE_SECONDS - 1,
        });
    });

    it('recalculates XP from stored eligible seconds', () => {
        expect(
            recalculateVoiceXpFromEvent({
                activityType: 'voice',
                voiceEligibleSeconds: 180,
            })
        ).toBe(DEFAULT_VOICE_XP_PER_MINUTE * 3);
        expect(
            recalculateVoiceXpFromEvent({
                activityType: 'message',
                voiceEligibleSeconds: 180,
            })
        ).toBe(0);
    });

    it('exposes code-default voice settings', () => {
        expect(getVoiceXpSettings().voiceXpEnabled).toBe(false);
        expect(getVoiceXpSettings().voiceXpPerMinute).toBe(DEFAULT_VOICE_XP_PER_MINUTE);
    });
});
