import {
    DEFAULT_PHOTO_XP_BONUS_MAX,
    DEFAULT_PHOTO_XP_BONUS_MIN,
    DEFAULT_REACTION_COOLDOWN_MS,
    DEFAULT_REACTION_XP_MAX,
    DEFAULT_REACTION_XP_MIN,
} from '../constants';
import { LevelingConfig } from '../data/levelingConfigSchema';
import { rollRandomXp } from './xpCalculator';

/**
 * Fields not exposed in the config modal are owned by code defaults so dev tuning
 * in constants.ts applies without DB data migrations.
 */
export function applyLevelingCodeDefaults(config: LevelingConfig): LevelingConfig {
    return {
        ...config,
        reactionXpMin: DEFAULT_REACTION_XP_MIN,
        reactionXpMax: DEFAULT_REACTION_XP_MAX,
        reactionCooldownMs: DEFAULT_REACTION_COOLDOWN_MS,
        photoXpBonusMin: DEFAULT_PHOTO_XP_BONUS_MIN,
        photoXpBonusMax: DEFAULT_PHOTO_XP_BONUS_MAX,
    };
}

export function getReactionXpGrant(config: LevelingConfig): number {
    const resolved = applyLevelingCodeDefaults(config);
    return rollRandomXp(resolved.reactionXpMin, resolved.reactionXpMax);
}
