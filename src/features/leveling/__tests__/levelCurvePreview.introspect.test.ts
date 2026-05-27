/**
 * Local tuning aid — edit TUNING_SCENARIO below, then run:
 *
 *   pnpm test levelCurvePreview.introspect
 *
 * The report prints to the terminal. Cooldowns are not included (action counts only).
 */
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_MESSAGE_COOLDOWN_MS,
    DEFAULT_MESSAGE_XP_MAX,
    DEFAULT_MESSAGE_XP_MIN,
    DEFAULT_PHOTO_XP_BONUS_MAX,
    DEFAULT_PHOTO_XP_BONUS_MIN,
    DEFAULT_REACTION_COOLDOWN_MS,
    DEFAULT_REACTION_XP_MAX,
    DEFAULT_REACTION_XP_MIN,
    DEFAULT_PHOTO_XP_BONUS_ENABLED,
    DEFAULT_REACTION_XP_ENABLED,
} from '../constants';
import { buildLevelCurvePreview, LevelCurvePreviewOptions } from '../logic/levelCurvePreview';
import { formatLevelCurvePreviewReport } from '../logic/formatLevelCurvePreviewReport';

/** Edit these values to simulate different guild configs before saving via /leveling-config. */
const TUNING_SCENARIO: LevelCurvePreviewOptions = {
    maxLevel: 15,
    messageXpMin: DEFAULT_MESSAGE_XP_MIN,
    messageXpMax: DEFAULT_MESSAGE_XP_MAX,
    reactionXpMin: DEFAULT_REACTION_XP_MIN,
    reactionXpMax: DEFAULT_REACTION_XP_MAX,
    reactionXpEnabled: DEFAULT_REACTION_XP_ENABLED,
    photoXpBonusMin: DEFAULT_PHOTO_XP_BONUS_MIN,
    photoXpBonusMax: DEFAULT_PHOTO_XP_BONUS_MAX,
    photoBonusEnabled: DEFAULT_PHOTO_XP_BONUS_ENABLED,
};

/** Reference only — not used in the action-count math (cooldowns affect real time, not XP per action). */
const TUNING_COOLDOWNS = {
    messageCooldownMs: DEFAULT_MESSAGE_COOLDOWN_MS,
    reactionCooldownMs: DEFAULT_REACTION_COOLDOWN_MS,
};

describe('level curve introspection', () => {
    it('prints the leveling curve for local tuning', () => {
        const preview = buildLevelCurvePreview(TUNING_SCENARIO);
        const report = formatLevelCurvePreviewReport(preview);

        console.log('\n' + report);
        console.log(
            `\nCooldowns (wall-clock only): messages ${TUNING_COOLDOWNS.messageCooldownMs / 1000}s, reactions ${
                TUNING_COOLDOWNS.reactionCooldownMs / 1000
            }s\n`
        );

        expect(preview.steps).toHaveLength(TUNING_SCENARIO.maxLevel - 1);
        expect(preview.extraLongMessageXp).toBeGreaterThan(preview.longMessageXp);
        expect(preview.cumulativeToMaxLevel.totalXp).toBeGreaterThan(0);
    });
});
