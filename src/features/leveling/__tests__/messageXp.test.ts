import { describe, expect, it } from 'vitest';
import { MESSAGE_XP_CAP, MESSAGE_XP_KEYFRAMES } from '../constants';
import {
    calculateMessageXp,
    getExtraLongMessageXp,
    getLongMessageXp,
    getShortMessageXp,
    interpolateMessageXpFromKeyframes,
    sampleMessageContent,
} from '../logic/messageXp';

describe('messageXp', () => {
    it('awards minimum XP for empty content (attachment-only posts)', () => {
        expect(calculateMessageXp('', 8, 25, 0.5)).toBe(8);
    });

    it('hits each keyframe anchor exactly', () => {
        for (const keyframe of MESSAGE_XP_KEYFRAMES) {
            expect(interpolateMessageXpFromKeyframes(keyframe.length)).toBeCloseTo(keyframe.xp, 5);
            expect(
                calculateMessageXp(sampleMessageContent(keyframe.length), 8, 25, 0.5)
            ).toBe(keyframe.xp);
        }
    });

    it('awards short and long representative XP from keyframes', () => {
        expect(getShortMessageXp(8, 25)).toBe(8);
        expect(getLongMessageXp(8, 25)).toBe(25);
        expect(getExtraLongMessageXp(8, 25)).toBe(MESSAGE_XP_CAP);
    });

    it('uses diminishing returns between keyframes', () => {
        const earlyHundredCharGain =
            interpolateMessageXpFromKeyframes(400) - interpolateMessageXpFromKeyframes(300);
        const lateHundredCharGain =
            interpolateMessageXpFromKeyframes(2500) - interpolateMessageXpFromKeyframes(2400);

        expect(lateHundredCharGain).toBeLessThan(earlyHundredCharGain);
    });

    it('caps beyond the final keyframe length', () => {
        expect(calculateMessageXp(sampleMessageContent(5000), 8, 25, 0.5)).toBe(MESSAGE_XP_CAP);
    });
});
