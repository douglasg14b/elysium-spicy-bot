import { ChannelType, PermissionsBitField, type Guild } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
    botCanPostWarningNotice,
    resolveWarningsModChannel,
    validateWarningsModChannel,
} from '../logic/warningModChannel';

describe('botCanPostWarningNotice', () => {
    it('requires view, send, and embed links', () => {
        expect(
            botCanPostWarningNotice(
                new PermissionsBitField([
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.EmbedLinks,
                ])
            )
        ).toBe(true);
        expect(
            botCanPostWarningNotice(
                new PermissionsBitField([
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                ])
            )
        ).toBe(false);
        expect(botCanPostWarningNotice(null)).toBe(false);
    });
});

const TEXT_CHANNEL_ID = '100000000000000001';
const FOREIGN_CHANNEL_ID = '900000000000000009';

/**
 * A guild whose channel cache holds one postable text channel, and whose `channels.fetch`
 * records every call. The id a route hands these functions comes from a request body, so a
 * fetch — `GET /channels/{id}` for any channel anywhere — is the thing that must not happen.
 */
function cacheOnlyGuild() {
    const fetch = vi.fn();
    const textChannel = {
        id: TEXT_CHANNEL_ID,
        type: ChannelType.GuildText,
        permissionsFor: () =>
            new PermissionsBitField([
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.SendMessages,
                PermissionsBitField.Flags.EmbedLinks,
            ]),
    };
    const guild = {
        id: 'guild-1',
        channels: { cache: new Map([[TEXT_CHANNEL_ID, textChannel]]), fetch },
        members: { me: { id: 'bot' } },
    } as unknown as Guild;

    return { guild, fetch, textChannel };
}

describe('the warnings mod channel lookups', () => {
    it('accepts this guild’s cached text channel', async () => {
        const { guild, fetch } = cacheOnlyGuild();

        await expect(validateWarningsModChannel(guild, TEXT_CHANNEL_ID)).resolves.toEqual({
            ok: true,
            channelId: TEXT_CHANNEL_ID,
        });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('refuses an id the guild does not hold without asking Discord about it', async () => {
        const { guild, fetch } = cacheOnlyGuild();

        const result = await validateWarningsModChannel(guild, FOREIGN_CHANNEL_ID);

        expect(result.ok).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('resolves a stored channel from the cache, and nothing for one that is gone', async () => {
        const { guild, fetch, textChannel } = cacheOnlyGuild();

        await expect(resolveWarningsModChannel(guild, TEXT_CHANNEL_ID)).resolves.toBe(textChannel);
        await expect(resolveWarningsModChannel(guild, FOREIGN_CHANNEL_ID)).resolves.toBeNull();
        expect(fetch).not.toHaveBeenCalled();
    });
});
