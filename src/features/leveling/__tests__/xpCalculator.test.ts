import { describe, expect, it } from 'vitest';
import {
    getLevelFromTotalXp,
    getTotalXpForLevel,
    getXpThresholdForLevel,
    getXpToNextLevel,
    messageHasImageAttachment,
    rollRandomXp,
} from '../logic/xpCalculator';

describe('xpCalculator', () => {
    it('uses the MEE6 threshold formula per level step', () => {
        expect(getXpThresholdForLevel(1)).toBe(155);
        expect(getXpThresholdForLevel(2)).toBe(220);
        expect(getXpThresholdForLevel(3)).toBe(295);
    });

    it('derives total XP required to reach a level', () => {
        expect(getTotalXpForLevel(1)).toBe(0);
        expect(getTotalXpForLevel(2)).toBe(155);
        expect(getTotalXpForLevel(3)).toBe(375);
    });

    it('derives level from total XP', () => {
        expect(getLevelFromTotalXp(0)).toBe(1);
        expect(getLevelFromTotalXp(154)).toBe(1);
        expect(getLevelFromTotalXp(155)).toBe(2);
        expect(getLevelFromTotalXp(374)).toBe(2);
        expect(getLevelFromTotalXp(375)).toBe(3);
    });

    it('supports multi-level jumps from large XP grants', () => {
        const totalXp = getTotalXpForLevel(5);
        expect(getLevelFromTotalXp(totalXp)).toBe(5);
    });

    it('reports remaining XP to the next level', () => {
        expect(getXpToNextLevel(0)).toBe(155);
        expect(getXpToNextLevel(100)).toBe(55);
        expect(getXpToNextLevel(155)).toBe(220);
    });

    it('rolls random XP within inclusive bounds', () => {
        expect(rollRandomXp(15, 25, 0)).toBe(15);
        expect(rollRandomXp(15, 25, 0.999)).toBe(25);
        expect(rollRandomXp(10, 10, 0.5)).toBe(10);
    });

    it('detects image attachments by content type or dimensions', () => {
        expect(messageHasImageAttachment([{ contentType: 'image/png' }])).toBe(true);
        expect(messageHasImageAttachment([{ contentType: 'application/pdf' }])).toBe(false);
        expect(messageHasImageAttachment([{ contentType: null, width: 800, height: 600 }])).toBe(true);
        expect(messageHasImageAttachment([{ contentType: null }])).toBe(false);
    });
});
