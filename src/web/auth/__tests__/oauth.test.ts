import { describe, expect, it } from 'vitest';
import { canManageGuild } from '../oauth';

/**
 * Guards the rule that decides who gets into the dashboard. The permission values are
 * real Discord bitfields, serialised as strings exactly as `/users/@me/guilds` returns
 * them.
 */

const ADMINISTRATOR = '8';
const MANAGE_GUILD = '32';
/** Kick + Ban + Moderate Members — a typical moderator, who must NOT qualify. */
const MODERATOR = String(0x2n | 0x4n | (1n << 40n));
const SEND_MESSAGES = '2048';

describe('canManageGuild', () => {
    it('admits the guild owner regardless of permission bits', () => {
        expect(canManageGuild({ owner: true, permissions: '0' })).toBe(true);
    });

    it('admits Manage Guild', () => {
        expect(canManageGuild({ owner: false, permissions: MANAGE_GUILD })).toBe(true);
    });

    it('admits Administrator even without Manage Guild', () => {
        // Discord does not expand ADMINISTRATOR into the other bits, so this has to be
        // checked explicitly — an admin without Manage Guild is legal.
        expect(canManageGuild({ owner: false, permissions: ADMINISTRATOR })).toBe(true);
    });

    it('rejects moderator permissions', () => {
        // Kick/Ban/Timeout moderate *members*; the dashboard changes server config.
        expect(canManageGuild({ owner: false, permissions: MODERATOR })).toBe(false);
    });

    it('rejects an ordinary member', () => {
        expect(canManageGuild({ owner: false, permissions: SEND_MESSAGES })).toBe(false);
    });

    it('admits a permission set that includes Manage Guild among others', () => {
        const combined = String(BigInt(MANAGE_GUILD) | BigInt(SEND_MESSAGES));
        expect(canManageGuild({ owner: false, permissions: combined })).toBe(true);
    });

    it('fails closed on a malformed permissions string', () => {
        expect(canManageGuild({ owner: false, permissions: 'not-a-number' })).toBe(false);
    });

    it('handles permission bitfields beyond 2^53', () => {
        // Permissions exceed Number.MAX_SAFE_INTEGER, which is why this is BigInt maths.
        const highBit = String((1n << 50n) | BigInt(MANAGE_GUILD));
        expect(canManageGuild({ owner: false, permissions: highBit })).toBe(true);
    });
});
