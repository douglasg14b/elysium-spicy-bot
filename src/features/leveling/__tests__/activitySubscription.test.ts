import { Events, type Message } from 'discord.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The real `initLeveling` runs below, so its gateway wiring is what is under test; only
 * the client is stubbed, since nothing here logs in.
 */
const clientOn = vi.fn();
vi.mock('../../../discordClient', () => ({
    DISCORD_CLIENT: { on: clientOn, once: vi.fn(), isReady: () => false },
}));

const { database } = await import('../../../features-system/data-persistence/database');
const { migrateTestDatabase } = await import(
    '../../../features-system/data-persistence/__tests__/support/migrateTestDatabase'
);
const { recordMessageActivity } = await import('../../../features-system/activity/activityRecorder');
const { registerActivitySubscriber } = await import('../../../features-system/activity');
const { levelingConfigRepo } = await import('../data/levelingConfigRepo');
const { initLeveling } = await import('../initLeveling');

/**
 * Leveling as a consumer of recorded activity, against the real migrated schema.
 *
 * The two filters are independent now: activity records whatever a member did, leveling
 * decides what earns XP. These cases pin the seam between them — that `initLeveling`
 * subscribes rather than listening, that a grant links to the event it was earned from,
 * and that the first divergence (`/`-prefixed messages) really diverges.
 */

const GUILD_ID = 'guild-1';
const GUILD = { id: GUILD_ID };

function aMessage(content: string): Message {
    return {
        inGuild: () => true,
        guildId: GUILD_ID,
        guild: GUILD,
        channelId: 'channel-1',
        // The recorder asks whether a message landed in a thread, as discord.js answers it.
        channel: { id: 'channel-1', isThread: () => false },
        system: false,
        webhookId: null,
        author: { id: 'user-1', bot: false },
        content,
        createdAt: new Date('2026-10-01T09:30:00.000Z'),
        attachments: { values: () => [] },
    } as unknown as Message;
}

beforeAll(async () => {
    await migrateTestDatabase();
    await levelingConfigRepo.upsertGuildSettings({ guildId: GUILD_ID, enabled: true });
    initLeveling();
});

beforeEach(async () => {
    await database.deleteFrom('leveling_xp_grants').execute();
    await database.deleteFrom('leveling_progress').execute();
    await database.deleteFrom('activity_events').execute();
});

describe('leveling consuming activity events', () => {
    it('listens for neither messages nor reactions itself, so nothing is granted twice', () => {
        const events = clientOn.mock.calls.map(([event]) => event);

        expect(events).not.toContain(Events.MessageCreate);
        expect(events).not.toContain(Events.MessageReactionAdd);
    });

    it('links a message grant to the activity event it was earned from', async () => {
        await recordMessageActivity(aMessage('hello there, you gorgeous menace'));

        const event = await database.selectFrom('activity_events').selectAll().executeTakeFirstOrThrow();
        const grant = await database.selectFrom('leveling_xp_grants').selectAll().executeTakeFirstOrThrow();

        expect(grant.activityType).toBe('message');
        expect(grant.activityEventId).toBe(event.id);
        // The date plugin's map follows the rename: a stale key would leave this a string.
        expect(grant.occurredAt).toBeInstanceOf(Date);
    });

    /*
     * The two cases below add consumers beside leveling's and leave them registered —
     * `initLeveling` wires once per process, so leveling's own cannot be put back after a
     * clear. Both are inert by the time they return: one only records its calls, the other
     * throws once.
     */
    it('still grants message XP with a second consumer subscribed after it', async () => {
        const second = vi.fn().mockResolvedValue(undefined);
        registerActivitySubscriber(second);

        await recordMessageActivity(aMessage('two of us listening now'));

        const event = await database.selectFrom('activity_events').selectAll().executeTakeFirstOrThrow();
        const grant = await database.selectFrom('leveling_xp_grants').selectAll().executeTakeFirstOrThrow();
        expect(grant.activityEventId).toBe(event.id);
        expect(second).toHaveBeenCalledWith(expect.objectContaining({ kind: 'message', activityEventId: event.id }));
    });

    it('still grants message XP when another consumer throws, and logs that one alone', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        registerActivitySubscriber(vi.fn().mockRejectedValueOnce(new Error('the other consumer exploded')));

        try {
            await recordMessageActivity(aMessage('carry on without them'));

            const grants = await database.selectFrom('leveling_xp_grants').selectAll().execute();
            expect(grants).toHaveLength(1);
            expect(error).toHaveBeenCalledTimes(1);
            expect(error).toHaveBeenCalledWith(expect.stringContaining('Subscriber failed'), expect.any(Error));
        } finally {
            error.mockRestore();
        }
    });

    it('records a /-prefixed message as activity and grants no XP for it', async () => {
        await recordMessageActivity(aMessage('/level'));

        const events = await database.selectFrom('activity_events').selectAll().execute();
        const grants = await database.selectFrom('leveling_xp_grants').selectAll().execute();

        expect(events).toHaveLength(1);
        expect(events[0]?.channelId).toBe('channel-1');
        expect(grants).toEqual([]);
    });
});
