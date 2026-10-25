import { ChannelType, type Guild } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { ResourceBindingEntity } from '../../data/resourceBindingsSchema';
import { readMessagePresence } from '../lookupBoundMessage';

/**
 * The rows `readMessagePresence` answers for without asking Discord, and a guild missing the
 * bot's own member. Every read of a real message is in `provisioningMessage.integration.test.ts`,
 * against TestDiscord.
 */

/** A guild nothing may touch: any read of it fails the test. */
const UNTOUCHABLE_GUILD = new Proxy({} as Guild, {
    get(_target, property) {
        throw new Error(`readMessagePresence read guild.${String(property)}`);
    },
});

function row(overrides: Partial<ResourceBindingEntity>): ResourceBindingEntity {
    return {
        id: 1,
        guildId: 'guild-1',
        ownerKind: 'journey',
        ownerKey: 'house',
        resourceKey: 'rules-panel',
        kind: 'message',
        state: 'created',
        discordId: '1100000000000000099',
        name: 'Rules panel',
        messageChannelId: '1100000000000000001',
        messageDigest: 'digest',
        createdAt: new Date('2026-10-25T10:00:00.000Z'),
        updatedAt: new Date('2026-10-25T10:00:00.000Z'),
        ...overrides,
    };
}

describe('readMessagePresence', () => {
    it('reads a posted row recording no channel as unreadable, so that one item blocks — not the whole preview', async () => {
        const presence = await readMessagePresence(UNTOUCHABLE_GUILD, [row({ messageChannelId: null })]);

        expect(presence.get('rules-panel')).toEqual({ unreadable: 'its record names no channel to look in' });
    });

    it('skips every row that names no post: another kind, an intent, no id', async () => {
        const presence = await readMessagePresence(UNTOUCHABLE_GUILD, [
            row({ resourceKey: 'rules', kind: 'textChannel', messageChannelId: null, messageDigest: null }),
            row({ resourceKey: 'intent', state: 'intended', discordId: null }),
            row({ resourceKey: 'no-id', discordId: null }),
        ]);

        expect(presence.size).toBe(0);
    });

    it('says it could not see the bot itself, rather than naming permissions, when the guild has no member for it — and fetches nothing', async () => {
        const channel = {
            id: '1100000000000000001',
            type: ChannelType.GuildText,
            permissionsFor: () => {
                throw new Error('permissionsFor was asked without a member');
            },
            messages: {
                fetch: () => {
                    throw new Error('the message was fetched');
                },
            },
        };
        const guild = {
            channels: { cache: { get: () => channel } },
            members: { me: null },
        } as unknown as Guild;

        const presence = await readMessagePresence(guild, [row({})]);

        expect(presence.get('rules-panel')).toEqual({
            unreadable: "couldn't see the bot's own member, so its permissions there can't be checked",
        });
    });
});
