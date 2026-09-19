import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
    PermissionIntentError,
    compilePermissionIntents,
    type PermissionIntent,
    type PermissionIntentContext,
} from '../permissionIntent';

/**
 * The permission grid, which decides what a provisioned channel actually allows.
 *
 * Worth real tests rather than a type check: every failure here produces a channel
 * that *exists* and is wrong, which is the failure mode no gate in this repo catches.
 * A channel silently readable by everyone looks identical to a correct one until
 * somebody reads it.
 */

const EVERYONE_ID = 'everyone-role';
const BOT_ID = 'bot-member';

function makeContext(overrides: Partial<PermissionIntentContext> = {}): PermissionIntentContext {
    const roles = new Map<string, unknown>([
        [EVERYONE_ID, { id: EVERYONE_ID, name: '@everyone' }],
        ['role-staff', { id: 'role-staff', name: 'Staff' }],
        ['role-verified', { id: 'role-verified', name: 'Verified' }],
    ]);

    const guild = {
        id: 'guild-1',
        name: 'Test Guild',
        roles: {
            everyone: { id: EVERYONE_ID },
            cache: {
                has: (id: string) => roles.has(id),
            },
        },
        members: { me: { id: BOT_ID } },
    };

    return {
        guild: guild as never,
        staffRoleIds: ['role-staff'],
        ...overrides,
    };
}

function overwriteFor(
    result: ReturnType<typeof compilePermissionIntents>,
    id: string
): { allow: bigint[]; deny: bigint[] } {
    const found = result.find((entry) => (entry as { id: string }).id === id);
    if (!found) throw new Error(`no overwrite for ${id}`);
    return found as never;
}

describe('compilePermissionIntents', () => {
    it('hides a channel from everyone while allowing a named role to read and write', () => {
        const intents: PermissionIntent[] = [
            { audience: 'everyone', access: 'hidden' },
            { audience: 'roles', roleIds: ['role-verified'], access: 'readWrite' },
        ];

        const result = compilePermissionIntents(intents, makeContext());

        const everyone = overwriteFor(result, EVERYONE_ID);
        expect(everyone.deny).toContain(PermissionFlagsBits.ViewChannel);
        expect(everyone.allow).toHaveLength(0);

        const verified = overwriteFor(result, 'role-verified');
        expect(verified.allow).toContain(PermissionFlagsBits.ViewChannel);
        expect(verified.allow).toContain(PermissionFlagsBits.SendMessages);
    });

    it('denies every way of posting for readOnly, not just SendMessages', () => {
        // A channel that denies SendMessages but permits thread replies and
        // reactions is not read-only, and looks read-only in the Discord UI.
        const result = compilePermissionIntents(
            [{ audience: 'everyone', access: 'readOnly' }],
            makeContext()
        );

        const everyone = overwriteFor(result, EVERYONE_ID);
        expect(everyone.allow).toContain(PermissionFlagsBits.ViewChannel);
        expect(everyone.deny).toContain(PermissionFlagsBits.SendMessages);
        expect(everyone.deny).toContain(PermissionFlagsBits.SendMessagesInThreads);
        expect(everyone.deny).toContain(PermissionFlagsBits.AddReactions);
    });

    it('lets a later intent override an earlier one for the same id', () => {
        // "deny everyone, then allow staff" must behave the way it reads even when
        // the same id appears twice.
        const result = compilePermissionIntents(
            [
                { audience: 'everyone', access: 'hidden' },
                { audience: 'everyone', access: 'readOnly' },
            ],
            makeContext()
        );

        const everyone = overwriteFor(result, EVERYONE_ID);
        expect(everyone.allow).toContain(PermissionFlagsBits.ViewChannel);
        expect(everyone.deny).not.toContain(PermissionFlagsBits.ViewChannel);
    });

    it('always grants the bot access, even when everyone is hidden', () => {
        // A channel the bot cannot see is one it can never repair.
        const result = compilePermissionIntents(
            [{ audience: 'everyone', access: 'hidden' }],
            makeContext()
        );

        const bot = overwriteFor(result, BOT_ID);
        expect(bot.allow).toContain(PermissionFlagsBits.ViewChannel);
        expect(bot.allow).toContain(PermissionFlagsBits.SendMessages);
        expect(bot.deny).toHaveLength(0);
    });

    it('resolves subjectAndStaff to the subject plus every staff role', () => {
        const result = compilePermissionIntents(
            [{ audience: 'subjectAndStaff', access: 'readWrite' }],
            makeContext({ subjectId: 'member-7', staffRoleIds: ['role-staff', 'role-verified'] })
        );

        expect(overwriteFor(result, 'member-7').allow).toContain(PermissionFlagsBits.ViewChannel);
        expect(overwriteFor(result, 'role-staff').allow).toContain(PermissionFlagsBits.ViewChannel);
        expect(overwriteFor(result, 'role-verified').allow).toContain(PermissionFlagsBits.ViewChannel);
    });

    describe('refuses rather than degrading', () => {
        it('rejects a roles intent naming no roles', () => {
            // Returning an empty overwrite list here would produce a channel with
            // *fewer* restrictions than asked for.
            expect(() =>
                compilePermissionIntents([{ audience: 'roles', roleIds: [], access: 'readWrite' }], makeContext())
            ).toThrow(PermissionIntentError);
        });

        it('rejects a roles intent naming a role that does not exist', () => {
            expect(() =>
                compilePermissionIntents(
                    [{ audience: 'roles', roleIds: ['role-ghost'], access: 'readWrite' }],
                    makeContext()
                )
            ).toThrow(/do not exist/i);
        });

        it('rejects subjectAndStaff with no subject', () => {
            expect(() =>
                compilePermissionIntents(
                    [{ audience: 'subjectAndStaff', access: 'readWrite' }],
                    makeContext({ subjectId: undefined })
                )
            ).toThrow(/needs a subject/i);
        });

        it('rejects subjectAndStaff with no staff roles configured', () => {
            expect(() =>
                compilePermissionIntents(
                    [{ audience: 'subjectAndStaff', access: 'readWrite' }],
                    makeContext({ subjectId: 'member-7', staffRoleIds: [] })
                )
            ).toThrow(/staff role/i);
        });

        it('rejects a guild whose bot member is not cached', () => {
            const context = makeContext();
            (context.guild as unknown as { members: { me: null } }).members.me = null;

            expect(() =>
                compilePermissionIntents([{ audience: 'everyone', access: 'hidden' }], context)
            ).toThrow(/not cached/i);
        });
    });
});
