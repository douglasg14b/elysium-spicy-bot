import { sql } from 'kysely';
import type { Message, MessageReaction, User } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { database } from '../../data-persistence/database';
import { migrateTestDatabase } from '../../data-persistence/__tests__/support/migrateTestDatabase';
import { recordMessageActivity, recordReactionActivity } from '../activityRecorder';
import { clearActivitySubscriber, registerActivitySubscriber } from '../activitySubscribers';
import { activityEventsRepo } from '../data/activityEventsRepo';

/**
 * The recorder against the real migrated schema.
 *
 * Deliberately imports nothing from leveling. The guarantee that matters most here is that
 * activity is recorded in a guild whose leveling is **off** — a quiet-timeout built on this
 * would otherwise kick a talkative member of any guild that never enabled XP.
 */

const GUILD_ID = 'guild-1';
const SENT_AT = new Date('2026-10-01T09:30:00.000Z');

/** A plain text channel, which discord.js reports as not a thread. */
const TEXT_CHANNEL = { id: 'channel-1', isThread: () => false };
/** A thread under `channel-1`, shaped the way discord.js answers for one. */
const THREAD = { id: 'thread-1', isThread: () => true, parentId: 'channel-1' };

/**
 * The guild as the recorder reads it. The channel cache holds the thread so a reaction
 * in it can find its parent without a fetch.
 */
const GUILD = { id: GUILD_ID, channels: { cache: new Map<string, unknown>([[THREAD.id, THREAD]]) } };

function aMessage(overrides: Record<string, unknown> = {}): Message {
    return {
        id: 'message-1',
        inGuild: () => true,
        guildId: GUILD_ID,
        guild: GUILD,
        channelId: TEXT_CHANNEL.id,
        channel: TEXT_CHANNEL,
        system: false,
        webhookId: null,
        author: { id: 'user-1', bot: false },
        content: 'hello',
        createdAt: SENT_AT,
        ...overrides,
    } as unknown as Message;
}

async function recordedRows() {
    return database.selectFrom('activity_events').selectAll().orderBy('id').execute();
}

beforeAll(async () => {
    await migrateTestDatabase();
});

beforeEach(async () => {
    await database.deleteFrom('activity_events').execute();
    await database.deleteFrom('leveling_config').execute();
});

afterEach(() => {
    clearActivitySubscriber();
    vi.restoreAllMocks();
});

describe('recordMessageActivity', () => {
    it('records a message with its channel in a guild whose leveling is disabled', async () => {
        await sql`
            INSERT INTO leveling_config (guild_id, enabled, notification_channel_id)
            VALUES (${GUILD_ID}, 0, '')
        `.execute(database);

        await recordMessageActivity(aMessage());

        const rows = await recordedRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            guildId: GUILD_ID,
            userId: 'user-1',
            channelId: 'channel-1',
            parentChannelId: null,
            kind: 'message',
            occurredAt: SENT_AT,
        });
    });

    it('records a reply in a thread against the thread, with the channel it sits under', async () => {
        await recordMessageActivity(aMessage({ channelId: THREAD.id, channel: THREAD }));

        const [row] = await recordedRows();
        expect(row).toMatchObject({ channelId: 'thread-1', parentChannelId: 'channel-1' });
    });

    it('notifies the subscriber with the id of the row it wrote', async () => {
        const subscriber = vi.fn().mockResolvedValue(undefined);
        registerActivitySubscriber(subscriber);

        await recordMessageActivity(aMessage());

        const [row] = await recordedRows();
        expect(subscriber).toHaveBeenCalledOnce();
        expect(subscriber.mock.calls[0]?.[0]).toMatchObject({
            kind: 'message',
            activityEventId: row?.id,
            channelId: 'channel-1',
            userId: 'user-1',
        });
    });

    it.each([
        ['a bot', { author: { id: 'bot-1', bot: true } }],
        ['a webhook', { webhookId: 'webhook-1' }],
        ['a system message', { system: true }],
        ['a DM', { inGuild: () => false, guildId: null, guild: null }],
    ])('records nothing for %s', async (_label, overrides) => {
        await recordMessageActivity(aMessage(overrides));

        expect(await recordedRows()).toEqual([]);
    });

    it('keeps the event when the subscriber throws', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        registerActivitySubscriber(async () => {
            throw new Error('subscriber exploded');
        });

        await expect(recordMessageActivity(aMessage())).resolves.toBeUndefined();

        expect(await recordedRows()).toHaveLength(1);
    });

    it('notifies nobody when the write fails, since there is no event to link to', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(activityEventsRepo, 'record').mockRejectedValue(new Error('database down'));
        const subscriber = vi.fn().mockResolvedValue(undefined);
        registerActivitySubscriber(subscriber);

        await expect(recordMessageActivity(aMessage())).resolves.toBeUndefined();

        expect(subscriber).not.toHaveBeenCalled();
    });
});

describe('recordReactionActivity', () => {
    function aReaction(channelId = 'channel-2') {
        const fetchMessage = vi.fn();
        return {
            reaction: {
                partial: true,
                message: { partial: true, guildId: GUILD_ID, guild: GUILD, channelId, fetch: fetchMessage },
            } as unknown as MessageReaction,
            fetchMessage,
        };
    }

    it('finds the parent of a thread it reacted in from the channel cache', async () => {
        const { reaction, fetchMessage } = aReaction(THREAD.id);
        const reactor = { partial: false, id: 'reactor-1', bot: false };

        await recordReactionActivity(reaction, reactor as unknown as User);

        expect(fetchMessage).not.toHaveBeenCalled();
        const [row] = await recordedRows();
        expect(row).toMatchObject({ channelId: 'thread-1', parentChannelId: 'channel-1', kind: 'reaction' });
    });

    it('records the reactor in the reacted message’s channel without fetching the message', async () => {
        const { reaction, fetchMessage } = aReaction();
        const reactor = { partial: true, fetch: vi.fn().mockResolvedValue({ id: 'reactor-1', bot: false }) };

        await recordReactionActivity(reaction, reactor as unknown as User);

        expect(fetchMessage).not.toHaveBeenCalled();
        const rows = await recordedRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ userId: 'reactor-1', channelId: 'channel-2', kind: 'reaction' });
    });

    it('records nothing when the reactor resolves to a bot', async () => {
        const { reaction } = aReaction();
        const reactor = { partial: true, fetch: vi.fn().mockResolvedValue({ id: 'bot-1', bot: true }) };

        await recordReactionActivity(reaction, reactor as unknown as User);

        expect(await recordedRows()).toEqual([]);
    });
});
