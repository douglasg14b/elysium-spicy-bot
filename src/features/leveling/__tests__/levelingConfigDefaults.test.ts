import { describe, expect, it } from 'vitest';
import {
    DEFAULT_PHOTO_XP_BONUS_MAX,
    DEFAULT_REACTION_COOLDOWN_MS,
    DEFAULT_REACTION_XP_MAX,
    DEFAULT_REACTION_XP_MIN,
} from '../constants';
import { applyLevelingCodeDefaults } from '../logic/levelingConfigDefaults';

describe('levelingConfigDefaults', () => {
    it('overlays code defaults for fields not configured via the modal', () => {
        const merged = applyLevelingCodeDefaults({
            guildId: 'g1',
            messageXpMin: 20,
            messageXpMax: 30,
            messageCooldownMs: 45_000,
            reactionXpMin: 99,
            reactionXpMax: 99,
            reactionCooldownMs: 1_000,
            photoXpBonusMin: 99,
            photoXpBonusMax: 99,
        } as never);

        expect(merged.messageXpMin).toBe(20);
        expect(merged.reactionXpMin).toBe(DEFAULT_REACTION_XP_MIN);
        expect(merged.reactionXpMax).toBe(DEFAULT_REACTION_XP_MAX);
        expect(merged.reactionCooldownMs).toBe(DEFAULT_REACTION_COOLDOWN_MS);
        expect(merged.photoXpBonusMax).toBe(DEFAULT_PHOTO_XP_BONUS_MAX);
    });
});
