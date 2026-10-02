import { ChannelType, type Client, type TextChannel } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { database } from '../../data-persistence/database';
import { migrateTestDatabase } from '../../data-persistence/__tests__/support/migrateTestDatabase';
import {
    TestDiscord,
    type ServerChannel,
    type ServerGuild,
    type ServerMember,
} from '../../../shared/__tests__/support/testDiscord';
import { backfillUnfilledGaps } from '../activityBackfill';
import { recordMessageActivity } from '../activityRecorder';
import { clearActivitySubscriber, registerActivitySubscriber } from '../activitySubscribers';
import { RECORDER_HEARTBEAT_MARGIN_MS } from '../backfillGaps';
import { activityRecorderSessionsRepo, type UnfilledRecorderSession } from '../data/activityRecorderSessionsRepo';

/**
 * The startup backfill against real discord.js and TestDiscord, writing to the real
 * migrated schema.
 *
 * Every scenario builds the history an outage left behind *before* the client connects,
 * so GUILD_CREATE carries each channel's `last_message_id` exactly as Discord would, and
 * the backfill has to find the gap from that alone.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The outage under test: three hours ago until one hour ago. */
const NOW = Date.now();
const GAP_START = new Date(NOW - 3 * HOUR);
const GAP_END = new Date(NOW - HOUR);

function at(offsetMs: number, from: Date = GAP_START): Date {
    return new Date(from.getTime() + offsetMs);
}

const started: TestDiscord[] = [];

afterEach(async () => {
    clearActivitySubscriber();
    vi.restoreAllMocks();
    // Rethrows any harness fault — which the backfill's per-channel catch would otherwise
    // have logged as an ordinary failing channel.
    for (const discord of started.splice(0)) await discord.destroy();
});

beforeAll(async () => {
    await migrateTestDatabase();
});

beforeEach(async () => {
    await database.deleteFrom('activity_events').execute();
    await database.deleteFrom('activity_recorder_sessions').execute();
});

interface Outage {
    readonly discord: TestDiscord;
    readonly guild: ServerGuild;
    readonly member: ServerMember;
}

function anOutage(): Outage {
    const discord = new TestDiscord();
    started.push(discord);
    const guild = discord.createGuild();
    return { discord, guild, member: guild.createMember({ username: 'brat_in_residence' }) };
}

/**
 * The session pair that frames {@link GAP_START}–{@link GAP_END}: one that was last seen
 * a heartbeat margin after the gap's start, and the one that started at its end.
 */
async function sessionsFramingTheGap(): Promise<UnfilledRecorderSession[]> {
    await activityRecorderSessionsRepo.open(at(RECORDER_HEARTBEAT_MARGIN_MS));
    await activityRecorderSessionsRepo.open(GAP_END);
    return activityRecorderSessionsRepo.findUnfilled();
}

async function backfill(client: Client<true>, sessions?: UnfilledRecorderSession[]): Promise<void> {
    await backfillUnfilledGaps(client, sessions ?? (await sessionsFramingTheGap()), new Date(NOW));
}

async function recordedRows() {
    return database.selectFrom('activity_events').selectAll().orderBy('occurredAt').execute();
}

/** The history pages the bot asked for, in order. */
function historyReads(discord: TestDiscord) {
    return discord.requests.filter((request) => request.method === 'GET' && request.path.endsWith('/messages'));
}

describe('paging through a channel', () => {
    it('pages forward until a page reaches the end of the gap, recording only what fell inside it', async () => {
        const { discord, guild, member } = anOutage();
        const channel = guild.createTextChannel({ name: 'aftercare' });
        channel.receiveMessage({ from: member, content: 'before the outage', sentAt: at(-HOUR) });
        // 150 inside the gap, then a full page's worth after it: the second page holds the
        // last 50 and the first 50 after, and nothing past it may be asked for.
        const missed: string[] = [];
        for (let index = 0; index < 150; index += 1) {
            missed.push(channel.receiveMessage({ from: member, content: `missed ${index}`, sentAt: at(index * 10_000) }));
        }
        for (let index = 0; index < 100; index += 1) {
            channel.receiveMessage({ from: member, content: `heard live ${index}`, sentAt: at(index * 1000, GAP_END) });
        }
        const client = await discord.start();

        await backfill(client);

        const rows = await recordedRows();
        expect(rows).toHaveLength(150);
        expect(rows.every((row) => row.occurredAt >= GAP_START && row.occurredAt < GAP_END)).toBe(true);
        expect(rows[0]).toMatchObject({ userId: member.id, channelId: channel.id, parentChannelId: null, kind: 'message' });
        expect(new Set(rows.map((row) => row.messageId)).size).toBe(150);
        const reads = historyReads(discord);
        expect(reads).toHaveLength(2);
        // Pages arrive newest first, so the next cursor is the first page's highest id.
        expect(reads[1]?.query?.after).toBe(missed[99]);
    });

    it('records the members, not bots, webhooks or system notices, and a thread reply under its parent', async () => {
        const { discord, guild, member } = anOutage();
        const channel = guild.createTextChannel({ name: 'confessions' });
        const thread = guild.createThread({ parent: channel, name: 'spill-it' });
        channel.receiveMessage({ from: member, content: 'kneel', sentAt: at(MINUTE) });
        channel.receiveMessage({ from: guild.bot, content: 'beep', sentAt: at(2 * MINUTE) });
        channel.receiveMessage({ from: 'webhook', content: 'crossposted', sentAt: at(3 * MINUTE) });
        channel.receiveMessage({ from: member, kind: 'joinNotice', sentAt: at(4 * MINUTE) });
        thread.receiveMessage({ from: member, content: 'in the thread', sentAt: at(5 * MINUTE) });
        const client = await discord.start();

        await backfill(client);

        const rows = await recordedRows();
        expect(rows.map((row) => ({ channelId: row.channelId, parentChannelId: row.parentChannelId }))).toEqual([
            { channelId: channel.id, parentChannelId: null },
            { channelId: thread.id, parentChannelId: channel.id },
        ]);
        expect(rows.every((row) => row.userId === member.id)).toBe(true);
    });
});

describe('choosing channels', () => {
    it('asks only channels whose last message is inside the gap and whose history the bot may read', async () => {
        const { discord, guild, member } = anOutage();
        const talkative = guild.createTextChannel({ name: 'talkative' });
        const quietSinceBefore = guild.createTextChannel({ name: 'quiet' });
        const neverUsed = guild.createTextChannel({ name: 'never-used' });
        // Visible but history-denied: live messages still arrive here, only the backfill is blind.
        const noHistory = guild.createTextChannel({ name: 'no-history' });
        noHistory.setOverwrite(guild.bot, { deny: ['ReadMessageHistory'] });
        const thread = guild.createThread({ parent: quietSinceBefore, name: 'side-chat' });

        talkative.receiveMessage({ from: member, content: 'still here', sentAt: at(MINUTE) });
        quietSinceBefore.receiveMessage({ from: member, content: 'last words', sentAt: at(-HOUR) });
        noHistory.receiveMessage({ from: member, content: 'heard live, never fetched', sentAt: at(MINUTE) });
        thread.receiveMessage({ from: member, content: 'threads count', sentAt: at(2 * MINUTE) });
        const client = await discord.start();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await backfill(client);

        const asked = historyReads(discord).map((request) => request.path);
        expect(asked.sort()).toEqual([`/channels/${talkative.id}/messages`, `/channels/${thread.id}/messages`].sort());
        expect(asked).not.toContain(`/channels/${neverUsed.id}/messages`);
        expect((await recordedRows()).map((row) => row.channelId).sort()).toEqual([talkative.id, thread.id].sort());
        // A channel the bot can see but not read back is a real hole, so it is named.
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(noHistory.id));
    });
});

describe('repeating a backfill', () => {
    it('inserts nothing new when the same gap is backfilled again', async () => {
        const { discord, guild, member } = anOutage();
        const channel = guild.createTextChannel();
        channel.receiveMessage({ from: member, content: 'once', sentAt: at(MINUTE) });
        channel.receiveMessage({ from: member, content: 'twice', sentAt: at(2 * MINUTE) });
        const client = await discord.start();
        const sessions = await sessionsFramingTheGap();

        await backfill(client, sessions);
        await backfill(client, sessions);

        expect(await recordedRows()).toHaveLength(2);
    });

    it('lets a live message the backfill already recorded insert nothing and notify nobody', async () => {
        const { discord, guild, member } = anOutage();
        const channel = guild.createTextChannel();
        const messageId = channel.receiveMessage({ from: member, content: 'raced', sentAt: at(MINUTE) });
        const client = await discord.start();
        await backfill(client);
        const subscriber = vi.fn().mockResolvedValue(undefined);
        registerActivitySubscriber(subscriber);
        const error = vi.spyOn(console, 'error');

        // The same message arriving through the live path, as MESSAGE_CREATE would hand it over.
        const live = await liveTextChannel(discord, guild, channel).messages.fetch(messageId);
        await recordMessageActivity(live);

        expect(await recordedRows()).toHaveLength(1);
        expect(subscriber).not.toHaveBeenCalled();
        // Skipped as already recorded, not refused by the unique index as a failed write.
        expect(error).not.toHaveBeenCalled();
    });
});

describe('what a backfill touches', () => {
    it('never notifies the subscriber about a recovered message', async () => {
        const { discord, guild, member } = anOutage();
        guild.createTextChannel().receiveMessage({ from: member, content: 'no XP for this', sentAt: at(MINUTE) });
        const client = await discord.start();
        const subscriber = vi.fn().mockResolvedValue(undefined);
        registerActivitySubscriber(subscriber);

        await backfill(client);

        expect(await recordedRows()).toHaveLength(1);
        expect(subscriber).not.toHaveBeenCalled();
    });

    it('logs and skips a channel Discord refuses, carries on, and still marks the gap filled', async () => {
        const { discord, guild, member } = anOutage();
        const refused = guild.createTextChannel({ name: 'locked-out' });
        const fine = guild.createTextChannel({ name: 'fine' });
        refused.receiveMessage({ from: member, content: 'lost', sentAt: at(MINUTE) });
        fine.receiveMessage({ from: member, content: 'kept', sentAt: at(MINUTE) });
        refused.refuseHistory();
        const client = await discord.start();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'info').mockImplementation(() => undefined);

        await backfill(client);

        expect((await recordedRows()).map((row) => row.channelId)).toEqual([fine.id]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(refused.id), expect.anything());
        const sessions = await database.selectFrom('activity_recorder_sessions').select('gapFilledAt').execute();
        expect(sessions.every((session) => session.gapFilledAt !== null)).toBe(true);
    });
});

describe('a guild that had not arrived at startup', () => {
    it('backfills every other guild but leaves the gap unfilled for the next start', async () => {
        const { discord, guild, member } = anOutage();
        const arrived = guild.createTextChannel();
        arrived.receiveMessage({ from: member, content: 'here', sentAt: at(MINUTE) });
        const late = discord.createGuild();
        const lateMember = late.createMember();
        late.createTextChannel().receiveMessage({ from: lateMember, content: 'not yet', sentAt: at(MINUTE) });
        const client = await discord.start();
        // As discord.js leaves a guild whose GUILD_CREATE missed `waitGuildTimeout`.
        discord.clientGuild(late).available = false;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'info').mockImplementation(() => undefined);

        await backfill(client);

        expect((await recordedRows()).map((row) => row.channelId)).toEqual([arrived.id]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(late.id));
        expect(await activityRecorderSessionsRepo.findUnfilled()).toHaveLength(1);
    });
});

describe('a crash mid-backfill', () => {
    it('fills both unfilled gaps, oldest first, and nothing the crashed session heard live', async () => {
        const { discord, guild, member } = anOutage();
        const channel = guild.createTextChannel();
        // Session 1 ran until T1. Session 2 started at T2, recorded live until it died after
        // its last heartbeat at T3, before its backfill finished. Session 3 starts at T4.
        const T1 = new Date(NOW - 5 * HOUR);
        const T2 = new Date(NOW - 4 * HOUR);
        const T3 = new Date(NOW - 3 * HOUR);
        const T4 = new Date(NOW - 2 * HOUR);
        const first = await activityRecorderSessionsRepo.open(new Date(NOW - 6 * HOUR));
        await activityRecorderSessionsRepo.heartbeat(first, T1);
        const crashed = await activityRecorderSessionsRepo.open(T2);
        await activityRecorderSessionsRepo.heartbeat(crashed, T3);
        const current = await activityRecorderSessionsRepo.open(T4);

        channel.receiveMessage({ from: member, content: 'in the first gap', sentAt: at(30 * MINUTE, T1) });
        channel.receiveMessage({ from: member, content: 'heard by session 2', sentAt: at(30 * MINUTE, T2) });
        channel.receiveMessage({ from: member, content: 'in the second gap', sentAt: at(30 * MINUTE, T3) });
        const client = await discord.start();
        const marked = vi.spyOn(activityRecorderSessionsRepo, 'markGapFilled');

        await backfill(client, await activityRecorderSessionsRepo.findUnfilled());

        expect(marked.mock.calls.map(([sessionId]) => sessionId)).toEqual([crashed, current]);
        expect((await recordedRows()).map((row) => row.occurredAt)).toEqual([
            at(30 * MINUTE, T1),
            at(30 * MINUTE, T3),
        ]);
        expect(await activityRecorderSessionsRepo.findUnfilled()).toEqual([]);
    });
});

function liveTextChannel(discord: TestDiscord, guild: ServerGuild, channel: ServerChannel): TextChannel {
    const live = discord.clientGuild(guild).channels.cache.get(channel.id);
    if (live?.type !== ChannelType.GuildText) throw new Error('The client holds no text channel for the fixture.');
    return live;
}
