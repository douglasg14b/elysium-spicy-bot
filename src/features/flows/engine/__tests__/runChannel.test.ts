import { describe, expect, it } from 'vitest';
import type { Channel } from 'discord.js';
import { asGuildTextChannel } from '../runChannel';

/**
 * A channel stub answering the two predicates the narrowing asks about. Built as
 * a plain object rather than a discord.js instance because the rule under test is
 * exactly "what do those two answers mean" — anything heavier would test the
 * library instead.
 */
function channelLike(options: { dm: boolean; text: boolean }): Channel {
    return {
        id: 'channel-1',
        isDMBased: () => options.dm,
        isTextBased: () => options.text,
    } as unknown as Channel;
}

describe('asGuildTextChannel', () => {
    it('keeps a guild text channel, which is where a run normally operates', () => {
        const channel = channelLike({ dm: false, text: true });

        expect(asGuildTextChannel(channel)).toBe(channel);
    });

    it('rejects a DM, which is not somewhere a guild run can post', () => {
        expect(asGuildTextChannel(channelLike({ dm: true, text: true }))).toBeUndefined();
    });

    it('rejects a non-text channel, which holds threads rather than messages', () => {
        expect(asGuildTextChannel(channelLike({ dm: false, text: false }))).toBeUndefined();
    });

    it('treats no channel as an ordinary absence rather than an error', () => {
        // A member join establishes no channel and is a perfectly normal run, so
        // both nullish forms answer "nowhere" instead of throwing.
        expect(asGuildTextChannel(null)).toBeUndefined();
        expect(asGuildTextChannel(undefined)).toBeUndefined();
    });
});
