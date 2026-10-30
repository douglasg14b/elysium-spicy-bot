import { PermissionsBitField, type ChatInputCommandInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleWarning } from '../../__tests__/support/sampleWarning';

/**
 * `/warn-clear`: the required reason, who the release is recorded against, the released
 * notice, and the reply reporting it. The release itself is `clearGuildWarning`'s, settled
 * against real SQLite in `warningWrites.test.ts`.
 */

const clearGuildWarning = vi.fn();
const notifyWarningReleased = vi.fn();

vi.mock('../../logic/clearGuildWarning', () => ({ clearGuildWarning }));
vi.mock('../../logic/warningChangeNotices', () => ({ notifyWarningReleased }));

const { handleWarnClearCommand, warnClearCommand } = await import('../warnClearCommand');

const guild = { id: 'guild-1' };

function interaction(options: { slug: string; reason: string }) {
    const order: string[] = [];
    const stub = {
        guildId: 'guild-1',
        guild,
        inGuild: () => true,
        memberPermissions: new PermissionsBitField([PermissionsBitField.Flags.ModerateMembers]),
        user: { id: 'mod-2', displayName: 'GlobalMod' },
        // A raw payload member, as when the guild is not cached: the nickname is `nick`.
        member: { nick: 'Mistress' },
        options: {
            getString: (name: string) => (name === 'slug' ? options.slug : options.reason),
        },
        reply: vi.fn(async () => order.push('reply')),
        deferReply: vi.fn(async () => order.push('defer')),
        editReply: vi.fn(async () => order.push('edit')),
    };
    return { stub, order, asInteraction: stub as unknown as ChatInputCommandInteraction };
}

const released = sampleWarning({
    clearedAt: new Date('2026-09-02T12:00:00.000Z'),
    clearedById: 'mod-2',
    clearedByName: 'Mistress',
    clearReason: 'Apologised nicely.',
});

beforeEach(() => {
    vi.clearAllMocks();
    clearGuildWarning.mockResolvedValue({ status: 'cleared', warning: released });
    notifyWarningReleased.mockResolvedValue('sent');
});

describe('/warn-clear', () => {
    it('declares a required reason of at most 500 characters', () => {
        const reason = warnClearCommand.toJSON().options?.find((option) => option.name === 'reason');

        expect(reason).toEqual(expect.objectContaining({ required: true, max_length: 500 }));
    });

    it('releases with the reason and the nickname, posts the released notice, and replies once', async () => {
        const { stub, order, asInteraction } = interaction({ slug: 'Consent-K7M2', reason: '  Apologised nicely.  ' });

        await handleWarnClearCommand(asInteraction);

        const releasedBy = { id: 'mod-2', name: 'Mistress' };
        expect(clearGuildWarning).toHaveBeenCalledWith('guild-1', 'Consent-K7M2', releasedBy, '  Apologised nicely.  ');
        // The notice is built from the row as saved, not from what the command was given.
        expect(notifyWarningReleased).toHaveBeenCalledWith(guild, released);
        expect(order).toEqual(['defer', 'edit']);
        expect(stub.editReply).toHaveBeenCalledWith({ content: 'Wiped `consent-k7m2`. Clean slate, you softie.' });
    });

    it('says so when the notice did not go out', async () => {
        notifyWarningReleased.mockResolvedValue('unconfigured');
        const { stub, asInteraction } = interaction({ slug: 'consent-k7m2', reason: 'Done.' });

        await handleWarnClearCommand(asInteraction);

        expect(stub.editReply).toHaveBeenCalledWith({
            content:
                'Wiped `consent-k7m2`. Clean slate, you softie.\n' +
                'No mod channel is configured, so this stayed in /warn-clear. Set one with /warnings-config.',
        });
    });

    it('answers a failed release through the deferred reply, once', async () => {
        clearGuildWarning.mockRejectedValue(new Error('database unavailable'));
        const { stub, order, asInteraction } = interaction({ slug: 'consent-k7m2', reason: 'Done.' });
        const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await handleWarnClearCommand(asInteraction);
        quiet.mockRestore();

        expect(order).toEqual(['defer', 'edit']);
        expect(stub.reply).not.toHaveBeenCalled();
        expect(notifyWarningReleased).not.toHaveBeenCalled();
    });

    it('posts no notice for a warning already released', async () => {
        clearGuildWarning.mockResolvedValue({ status: 'already-cleared', warning: sampleWarning() });
        const { stub, asInteraction } = interaction({ slug: 'consent-k7m2', reason: 'Again.' });

        await handleWarnClearCommand(asInteraction);

        expect(notifyWarningReleased).not.toHaveBeenCalled();
        expect(stub.editReply).toHaveBeenCalledWith({
            content: '`consent-k7m2` is already cleared. You already did the soft thing.',
        });
    });
});
