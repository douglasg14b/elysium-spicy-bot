import { DiscordAPIError, RESTJSONErrorCodes, type Guild, type GuildMember } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { block as kickMember } from '../blocks/actionKickMember';
import type { FlowRunContext } from '../blocks/types';

/**
 * Kick Member against hand-built members.
 *
 * Not TestDiscord: `kickable` turns on role hierarchy, and the harness says outright
 * that its role positions are made up, so a hierarchy answer from it would be one the
 * harness invented. The cases here are about what the block does with each answer.
 */

const MEMBER_ID = 'member-1';
const OWNER_ID = 'owner-1';
const BOT_ID = 'bot-1';

function unknownMember(): DiscordAPIError {
    return new DiscordAPIError(
        { code: RESTJSONErrorCodes.UnknownMember, message: 'Unknown Member' },
        RESTJSONErrorCodes.UnknownMember,
        404,
        'GET',
        '',
        {}
    );
}

interface Fixture {
    readonly context: FlowRunContext;
    readonly kick: ReturnType<typeof vi.fn>;
    readonly fetch: ReturnType<typeof vi.fn>;
}

function fixture(options: { kickable?: boolean; memberId?: string; botCanKick?: boolean } = {}): Fixture {
    const kick = vi.fn().mockResolvedValue(undefined);
    const guild = {
        ownerId: OWNER_ID,
        client: { user: { id: BOT_ID } },
        members: {
            me: { permissions: { has: () => options.botCanKick ?? true } },
            fetch: vi.fn(),
        },
    };
    const member = {
        id: options.memberId ?? MEMBER_ID,
        guild,
        user: { username: 'brat' },
        kickable: options.kickable ?? true,
        kick,
    } as unknown as GuildMember;
    guild.members.fetch.mockResolvedValue(member);

    const context = {
        guild: guild as unknown as Guild,
        subject: { id: member.id },
        variables: {},
    } as unknown as FlowRunContext;

    return { context, kick, fetch: guild.members.fetch };
}

describe('action.kickMember', () => {
    it('kicks the member fresh from Discord, with the reason for the audit log', async () => {
        const { context, kick, fetch } = fixture();

        const outcome = await kickMember.run({ reason: 'Ghosted us' }, context);

        expect(outcome).toEqual({ kind: 'continue' });
        expect(fetch).toHaveBeenCalledWith({ user: MEMBER_ID, force: true });
        expect(kick).toHaveBeenCalledWith('Ghosted us');
    });

    it('trims a reason that rendered past the audit-log limit rather than refusing the kick', async () => {
        const { context, kick } = fixture();

        await kickMember.run({ reason: '😈'.repeat(600) }, context);

        expect(kick).toHaveBeenCalledWith('😈'.repeat(512));
    });

    it('carries on when the member has already left', async () => {
        const { context, kick, fetch } = fixture();
        fetch.mockRejectedValue(unknownMember());

        expect(await kickMember.run({}, context)).toEqual({ kind: 'continue' });
        expect(kick).not.toHaveBeenCalled();
    });

    it('carries on when the member leaves between the fetch and the kick', async () => {
        const { context, kick } = fixture();
        kick.mockRejectedValue(unknownMember());

        expect(await kickMember.run({}, context)).toEqual({ kind: 'continue' });
    });

    it('fails naming the owner when told to kick them', async () => {
        const { context, kick } = fixture({ kickable: false, memberId: OWNER_ID });

        const outcome = await kickMember.run({}, context);

        expect(outcome).toEqual({ kind: 'fail', error: expect.stringContaining('owns the server') });
        expect(kick).not.toHaveBeenCalled();
    });

    it('fails naming the role order when the member outranks the bot', async () => {
        const { context } = fixture({ kickable: false });

        expect(await kickMember.run({}, context)).toEqual({
            kind: 'fail',
            error: expect.stringContaining("highest role ranks at or above the bot's"),
        });
    });

    it('fails naming the permission when the bot cannot kick anyone', async () => {
        const { context } = fixture({ kickable: false, botCanKick: false });

        expect(await kickMember.run({}, context)).toEqual({
            kind: 'fail',
            error: expect.stringContaining('Kick Members permission'),
        });
    });

    it('lets any other failure through to the executor', async () => {
        const { context, fetch } = fixture();
        fetch.mockRejectedValue(new Error('gateway hiccup'));

        await expect(kickMember.run({}, context)).rejects.toThrow('gateway hiccup');
    });
});
