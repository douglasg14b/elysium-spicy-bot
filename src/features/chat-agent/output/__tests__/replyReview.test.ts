import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { GuildBasedChannel, GuildMember } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { Viewers } from '../../tools/visibleChannels';
import { redoInstruction, reviewReply, type ReviewContext } from '../replyReview';

/** A server with #general and #selfies, which Vex can see. */
function fakeViewers(): Viewers {
    const guild = {
        id: 'guild',
        channels: { cache: new Map<string, GuildBasedChannel>() },
        members: { cache: new Map<string, GuildMember>() },
        roles: { cache: new Map() },
    };
    for (const [id, name] of [
        ['100000000000000001', 'general'],
        ['100000000000000002', 'selfies'],
    ]) {
        guild.channels.cache.set(id, {
            id,
            name,
            type: ChannelType.GuildText,
            position: 0,
            parent: null,
            isThread: () => false,
            permissionsFor: () => ({ has: (flag: bigint) => flag === PermissionFlagsBits.ViewChannel }),
        } as unknown as GuildBasedChannel);
    }
    const vex = { id: 'vex', displayName: 'Vex', user: { username: 'vex_irl', bot: false }, guild } as unknown as GuildMember;
    guild.members.cache.set('vex', vex);
    return [vex];
}

const SOCIAL: ReviewContext = { viewers: fakeViewers(), inTicket: false, botName: 'BrattyBot', toolNames: ['getServerRules', 'stayQuiet'] };
const TICKET: ReviewContext = { ...SOCIAL, inTicket: true };

describe('reviewReply — fixed in code', () => {
    it('strips a copied chat-log prefix', () => {
        expect(reviewReply('→ [2026-11-07 23:40] BrattyBot: Hi, Vex.', SOCIAL, 'first')).toMatchObject({ verdict: 'post', text: 'Hi, Vex.' });
        expect(reviewReply('BrattyBot: Hi.', SOCIAL, 'first')).toMatchObject({ verdict: 'post', text: 'Hi.' });
    });

    it('leaves a reply that only opens with brackets alone', () => {
        expect(reviewReply('[sighs] Fine.', SOCIAL, 'first')).toMatchObject({ verdict: 'post', text: '[sighs] Fine.' });
    });

    it('unwraps a reply quoted end to end, but not one that quotes inside', () => {
        expect(reviewReply('"Not a chance."', SOCIAL, 'first')).toMatchObject({ text: 'Not a chance.' });
        expect(reviewReply('“Not a chance.”', SOCIAL, 'first')).toMatchObject({ text: 'Not a chance.' });
        expect(reviewReply('"DMs closed" means no. "Ask to DM" means ask.', SOCIAL, 'first')).toMatchObject({
            text: '"DMs closed" means no. "Ask to DM" means ask.',
        });
    });

    it('keeps two emoji and drops the rest, joined and skin-toned ones whole', () => {
        expect(reviewReply('Fine 😏 fine 👍🏽 fine 🧑‍💻 fine 🔥.', SOCIAL, 'first')).toMatchObject({ text: 'Fine 😏 fine 👍🏽 fine fine.' });
    });

    it('posts the linked, split reply', () => {
        expect(reviewReply('Selfies go in #selfies.', SOCIAL, 'first')).toEqual({
            verdict: 'post',
            text: 'Selfies go in #selfies.',
            parts: ['Selfies go in <#100000000000000002>.'],
        });
    });
});

describe('reviewReply — turned back', () => {
    it('turns back an empty reply, and is silent about it in a ticket', () => {
        expect(reviewReply('  ​ ', SOCIAL, 'first')).toEqual({ verdict: 'redo', problems: [{ kind: 'empty' }] });
        expect(reviewReply('', SOCIAL, 'last')).toEqual({ verdict: 'fallback', problems: [{ kind: 'empty' }] });
        expect(reviewReply('', TICKET, 'first')).toEqual({ verdict: 'quiet' });
    });

    it('turns back a tool call written out, and in a ticket takes it as the silence it was choosing', () => {
        for (const written of ['[{"name": "getServerRules", "arguments": {}}]', 'stayQuiet(reason="banter")', 'Stay quiet. Reason: not a question']) {
            expect(reviewReply(written, SOCIAL, 'first')).toEqual({ verdict: 'redo', problems: [{ kind: 'toolCallAsText' }] });
            expect(reviewReply(written, TICKET, 'first')).toEqual({ verdict: 'quiet' });
        }
    });

    it('turns back a pet name used to address someone, and nothing that merely contains the word', () => {
        expect(reviewReply('Oh, *darling*, I’m a bot.', SOCIAL, 'first')).toEqual({ verdict: 'redo', problems: [{ kind: 'petName', word: 'darling' }] });
        expect(reviewReply('Been here since day one, sweetheart.', SOCIAL, 'first')).toMatchObject({ verdict: 'redo' });
        expect(reviewReply('Honey, no.', SOCIAL, 'first')).toMatchObject({ verdict: 'redo' });
        expect(reviewReply("That's above your pay grade, love — ask a mod.", SOCIAL, 'first')).toEqual({ verdict: 'redo', problems: [{ kind: 'petName', word: 'love' }] });
        expect(reviewReply('Kitten play lives in its own channel; honey badgers do not.', SOCIAL, 'first')).toMatchObject({ verdict: 'post' });
        expect(reviewReply("I'd love to, but no. No love lost, though — made with love.", SOCIAL, 'first')).toMatchObject({ verdict: 'post' });
        expect(reviewReply('Oh, darling, no.', SOCIAL, 'last')).toEqual({ verdict: 'fallback', problems: [{ kind: 'petName', word: 'darling' }] });
    });

    it('turns back a made-up channel, then posts it without its # on the last try', () => {
        expect(reviewReply('Try #nsfw-chat or #general.', SOCIAL, 'first')).toEqual({
            verdict: 'redo',
            problems: [{ kind: 'unknownChannel', names: ['nsfw-chat'] }],
        });
        expect(reviewReply('Try #nsfw-chat or #general.', SOCIAL, 'last')).toMatchObject({
            verdict: 'post',
            parts: ['Try nsfw-chat or <#100000000000000001>.'],
        });
    });

    it('does not count a number as a channel', () => {
        expect(reviewReply('Rule #3, read it.', SOCIAL, 'first')).toMatchObject({ verdict: 'post' });
    });
});

describe('redoInstruction', () => {
    it('names every problem, so the second try fixes exactly that', () => {
        expect(
            redoInstruction([
                { kind: 'petName', word: 'darling' },
                { kind: 'unknownChannel', names: ['nsfw-chat', 'venting'] },
            ])
        ).toBe(
            '[Not posted: it called them "darling" — no pet names; #nsfw-chat, #venting are not a channel here — name only channels your tools returned, or none. Write your reply to the same message again, fixing only that. Nobody saw the first one.]'
        );
    });
});
