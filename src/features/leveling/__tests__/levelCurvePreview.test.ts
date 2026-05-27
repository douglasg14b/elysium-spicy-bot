import { describe, expect, it } from 'vitest';
import { getTotalXpForLevel, getXpThresholdForLevel } from '../logic/xpCalculator';
import { getExtraLongMessageXp, getLongMessageXp, getShortMessageXp } from '../logic/messageXp';
import {
    buildLevelCurvePreview,
    buildLevelCurvePreviewFromConfig,
    estimateActionsNeeded,
    estimateActionsNeededFromRange,
} from '../logic/levelCurvePreview';

describe('levelCurvePreview', () => {
    const defaultOptions = {
        maxLevel: 5,
        messageXpMin: 8,
        messageXpMax: 25,
        reactionXpMin: 1,
        reactionXpMax: 2,
        reactionXpEnabled: true,
        photoXpBonusMin: 10,
        photoXpBonusMax: 20,
        photoBonusEnabled: true,
    };

    it('estimates action counts from fixed XP per action', () => {
        expect(estimateActionsNeeded(155, 15)).toEqual({ min: 11, max: 11, avg: 11 });
    });

    it('builds per-level step previews with short, long, and extra long message columns', () => {
        const preview = buildLevelCurvePreview(defaultOptions);
        const shortXp = getShortMessageXp(8, 25);
        const longXp = getLongMessageXp(8, 25);
        const extraLongXp = getExtraLongMessageXp(8, 25);

        expect(preview.steps).toHaveLength(4);
        expect(preview.shortMessageXp).toBe(shortXp);
        expect(preview.longMessageXp).toBe(longXp);
        expect(preview.extraLongMessageXp).toBe(extraLongXp);
        expect(preview.steps[0]).toMatchObject({
            level: 1,
            nextLevel: 2,
            xpRequired: getXpThresholdForLevel(1),
            cumulativeXp: getTotalXpForLevel(2),
            shortMessages: estimateActionsNeeded(getXpThresholdForLevel(1), shortXp),
            longMessages: estimateActionsNeeded(getXpThresholdForLevel(1), longXp),
            extraLongMessages: estimateActionsNeeded(getXpThresholdForLevel(1), extraLongXp),
        });
    });

    it('omits disabled activity columns', () => {
        const preview = buildLevelCurvePreview({
            ...defaultOptions,
            reactionXpEnabled: false,
            photoBonusEnabled: false,
        });

        expect(preview.steps[0]?.reactions).toBeNull();
        expect(preview.steps[0]?.photoMessages).toBeNull();
        expect(preview.cumulativeToMaxLevel.reactions).toBeNull();
    });

    it('uses guild config when present and defaults otherwise', () => {
        const fromDefaults = buildLevelCurvePreviewFromConfig(null, 3);
        const fromConfig = buildLevelCurvePreviewFromConfig(
            {
                messageXpMin: 10,
                messageXpMax: 10,
                reactionXpMin: 1,
                reactionXpMax: 1,
                reactionXpEnabled: true,
                photoXpBonusMin: 0,
                photoXpBonusMax: 0,
                photoBonusEnabled: false,
            } as never,
            3
        );

        expect(fromDefaults.shortMessageXp).toBe(8);
        expect(fromDefaults.longMessageXp).toBe(25);
        expect(fromDefaults.extraLongMessageXp).toBe(50);
        expect(fromConfig.steps[0]?.shortMessages).toEqual({ min: 20, max: 20, avg: 20 });
        expect(fromConfig.steps[0]?.photoMessages).toBeNull();
    });

    it('reflects reaction XP range in estimates', () => {
        const preview = buildLevelCurvePreview(defaultOptions);
        expect(preview.steps[0]?.reactions).toEqual(
            estimateActionsNeededFromRange(getXpThresholdForLevel(1), { min: 1, max: 2, avg: 1.5 })
        );
    });

    it('summarizes cumulative actions to reach the max level', () => {
        const preview = buildLevelCurvePreview({ ...defaultOptions, maxLevel: 3 });
        const totalXp = getTotalXpForLevel(3);

        expect(preview.cumulativeToMaxLevel.totalXp).toBe(totalXp);
        expect(preview.cumulativeToMaxLevel.longMessages.avg).toBeGreaterThan(0);
        expect(preview.cumulativeToMaxLevel.longMessages.avg).toBeLessThan(
            preview.cumulativeToMaxLevel.shortMessages.avg
        );
    });
});
