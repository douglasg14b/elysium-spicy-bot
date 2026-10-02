import { describe, expect, it } from 'vitest';
import { isCooldownActive, isSlashCommandMessage } from '../logic/activityFilters';

describe('activityFilters', () => {
    it('treats slash command messages as non-xp messages', () => {
        expect(isSlashCommandMessage({ content: '/level' } as never)).toBe(true);
        expect(isSlashCommandMessage({ content: 'hello' } as never)).toBe(false);
    });

    it('detects active cooldown windows', () => {
        const now = new Date('2026-05-26T12:00:00.000Z');
        const recent = new Date('2026-05-26T11:59:30.000Z');

        expect(isCooldownActive(recent, 60_000, now)).toBe(true);
        expect(isCooldownActive(recent, 20_000, now)).toBe(false);
        expect(isCooldownActive(null, 60_000, now)).toBe(false);
    });
});
