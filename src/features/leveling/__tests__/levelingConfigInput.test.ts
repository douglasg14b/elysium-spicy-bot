import { describe, expect, it } from 'vitest';
import { buildLevelUpMessage } from '../logic/levelUpMessage';

describe('levelUpMessage', () => {
    it('builds a mention-safe level-up message', () => {
        expect(buildLevelUpMessage({ userId: '123', level: 5, totalXp: 2500 })).toBe(
            '🎉 <@123> leveled up to **Level 5**! (2,500 total XP)'
        );
    });
});
