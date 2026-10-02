import type { Message } from 'discord.js';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { database } from '../../data-persistence/database';
import { migrateTestDatabase } from '../../data-persistence/__tests__/support/migrateTestDatabase';
import { recordMessageActivity } from '../activityRecorder';
import { activityEventsRepo, type RecordActivityEventInput } from '../data/activityEventsRepo';

/**
 * When someone last said something, and where — against the real migrated schema.
 *
 * The thread case goes through the recorder rather than a hand-inserted row, so it
 * proves the whole chain a timed park relies on: a reply in a thread is recorded with
 * its parent, and asking about the parent finds it.
 */

const GUILD_ID = 'guild-1';
const CHANNEL_ID = 'channel-1';
const THREAD_ID = 'thread-1';
const MINUTE = 60_000;
const BASE = new Date('2026-10-01T12:00:00.000Z');

function at(minutes: number): Date {
    return new Date(BASE.getTime() + minutes * MINUTE);
}

async function record(overrides: Partial<RecordActivityEventInput>): Promise<void> {
    await activityEventsRepo.record({
        guildId: GUILD_ID,
        userId: 'member-1',
        channelId: CHANNEL_ID,
        parentChannelId: null,
        messageId: null,
        kind: 'message',
        occurredAt: BASE,
        ...overrides,
    });
}

function aThreadReply(sentAt: Date): Message {
    return {
        id: 'message-1',
        inGuild: () => true,
        guildId: GUILD_ID,
        guild: { id: GUILD_ID },
        channelId: THREAD_ID,
        channel: { id: THREAD_ID, isThread: () => true, parentId: CHANNEL_ID },
        system: false,
        webhookId: null,
        author: { id: 'member-1', bot: false },
        content: 'still here',
        createdAt: sentAt,
    } as unknown as Message;
}

beforeAll(async () => {
    await migrateTestDatabase();
});

beforeEach(async () => {
    await database.deleteFrom('activity_events').execute();
});

describe('findLastMessageAt', () => {
    it('counts a reply in a thread toward the channel the thread sits under', async () => {
        await record({ occurredAt: at(0) });
        await recordMessageActivity(aThreadReply(at(30)));

        const last = await activityEventsRepo.findLastMessageAt({ guildId: GUILD_ID, channelId: CHANNEL_ID });

        expect(last).toEqual(at(30));
    });

    it('takes the channel itself when it is newer than any thread under it', async () => {
        await record({ channelId: THREAD_ID, parentChannelId: CHANNEL_ID, occurredAt: at(10) });
        await record({ occurredAt: at(20) });

        expect(await activityEventsRepo.findLastMessageAt({ guildId: GUILD_ID, channelId: CHANNEL_ID })).toEqual(
            at(20)
        );
    });

    it('does not count a reaction', async () => {
        await record({ occurredAt: at(0) });
        await record({ kind: 'reaction', occurredAt: at(45) });

        expect(await activityEventsRepo.findLastMessageAt({ guildId: GUILD_ID, userId: 'member-1' })).toEqual(at(0));
        expect(await activityEventsRepo.findLastMessageAt({ guildId: GUILD_ID, channelId: CHANNEL_ID })).toEqual(
            at(0)
        );
    });

    it('narrows a channel to one member when asked about them', async () => {
        await record({ userId: 'member-1', occurredAt: at(0) });
        await record({ userId: 'member-2', occurredAt: at(50) });

        expect(
            await activityEventsRepo.findLastMessageAt({ guildId: GUILD_ID, userId: 'member-1', channelId: CHANNEL_ID })
        ).toEqual(at(0));
        expect(await activityEventsRepo.findLastMessageAt({ guildId: GUILD_ID, channelId: CHANNEL_ID })).toEqual(
            at(50)
        );
    });

    it('answers null when nothing matches', async () => {
        await record({ guildId: 'other-guild' });

        expect(await activityEventsRepo.findLastMessageAt({ guildId: GUILD_ID, userId: 'member-1' })).toBeNull();
    });

    it('refuses to answer for a whole guild', async () => {
        await expect(
            activityEventsRepo.findLastMessageAt({ guildId: GUILD_ID, userId: '', channelId: '' })
        ).rejects.toThrow('needs a user or a channel');
    });
});
