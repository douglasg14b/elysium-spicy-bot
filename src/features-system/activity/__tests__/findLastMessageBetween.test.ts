import {
    CompiledQuery,
    type KyselyPlugin,
    type PluginTransformQueryArgs,
    type PluginTransformResultArgs,
    type QueryResult,
    type RootOperationNode,
    type UnknownRow,
} from 'kysely';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { database } from '../../data-persistence/database';
import { migrateTestDatabase } from '../../data-persistence/__tests__/support/migrateTestDatabase';
import { ActivityEventsRepo, activityEventsRepo, type RecordActivityEventInput } from '../data/activityEventsRepo';

/**
 * "When did this member last say anything here between then and now" — the question the
 * outage catch-up asks for every parked message wait — and the plans SQLite picks for it
 * and for the member-in-a-channel shapes of `findLastMessageAt`, against the real migrated
 * schema.
 */

const GUILD_ID = 'guild-1';
const CHANNEL_ID = 'channel-1';
const THREAD_ID = 'thread-1';
const MINUTE = 60_000;
const BASE = new Date('2026-10-03T12:00:00.000Z');

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
        occurredAt: at(0),
        ...overrides,
    });
}

const SPAN = { guildId: GUILD_ID, userId: 'member-1', from: at(10), to: at(20) };

beforeAll(async () => {
    await migrateTestDatabase();
});

beforeEach(async () => {
    await database.deleteFrom('activity_events').execute();
});

describe('findLastMessageBetween', () => {
    it('finds a message inside the span, bounds included', async () => {
        await record({ occurredAt: at(10) });

        expect(await activityEventsRepo.findLastMessageBetween({ ...SPAN, channelId: CHANNEL_ID })).toEqual(at(10));
        expect(await activityEventsRepo.findLastMessageBetween({ ...SPAN, from: at(0), to: at(10) })).toEqual(at(10));
    });

    it('answers with the latest of several, wherever under the channel it was posted', async () => {
        // The catch-up wakes a run once for all of them, so the next wait must listen after the newest.
        await record({ occurredAt: at(12) });
        await record({ channelId: THREAD_ID, parentChannelId: CHANNEL_ID, occurredAt: at(18) });
        await record({ occurredAt: at(15) });
        // Outside the span, so not the answer even though it is newer.
        await record({ occurredAt: at(25) });

        expect(await activityEventsRepo.findLastMessageBetween({ ...SPAN, channelId: CHANNEL_ID })).toEqual(at(18));
        expect(await activityEventsRepo.findLastMessageBetween(SPAN)).toEqual(at(18));
    });

    it('counts a reply in a thread toward the channel the thread sits under', async () => {
        await record({ channelId: THREAD_ID, parentChannelId: CHANNEL_ID, occurredAt: at(15) });

        expect(await activityEventsRepo.findLastMessageBetween({ ...SPAN, channelId: CHANNEL_ID })).toEqual(at(15));
    });

    it('looks anywhere in the guild when no channel is named', async () => {
        await record({ channelId: 'channel-2', occurredAt: at(15) });

        expect(await activityEventsRepo.findLastMessageBetween(SPAN)).toEqual(at(15));
        expect(await activityEventsRepo.findLastMessageBetween({ ...SPAN, channelId: CHANNEL_ID })).toBeNull();
    });

    it.each([
        ['before the span', { occurredAt: at(9) }],
        ['after the span', { occurredAt: at(21) }],
        ['by somebody else', { userId: 'member-2', occurredAt: at(15) }],
        ['a reaction', { kind: 'reaction' as const, occurredAt: at(15) }],
        ['in another guild', { guildId: 'guild-2', occurredAt: at(15) }],
    ])('finds nothing for a message %s', async (_label, overrides) => {
        await record(overrides);

        expect(await activityEventsRepo.findLastMessageBetween({ ...SPAN, channelId: CHANNEL_ID })).toBeNull();
    });
});

/**
 * Records every query a repo built, compiled as it would run, so the test can ask SQLite
 * how it would plan exactly that SQL rather than a hand-written copy that could drift.
 */
class CapturingPlugin implements KyselyPlugin {
    readonly queries: CompiledQuery[] = [];

    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
        this.queries.push(database.getExecutor().compileQuery(args.node, args.queryId));
        return args.node;
    }

    async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
        return args.result;
    }
}

/** The index each query the repo issued would search, as SQLite's planner reports it. */
async function plannedIndexes(ask: (repo: ActivityEventsRepo) => Promise<unknown>): Promise<string[]> {
    const capture = new CapturingPlugin();
    await ask(new ActivityEventsRepo(database.withPlugin(capture)));

    const details: string[] = [];
    for (const query of capture.queries) {
        const plan = await database.executeQuery<{ detail: string }>(
            CompiledQuery.raw(`EXPLAIN QUERY PLAN ${query.sql}`, [...query.parameters])
        );
        details.push(plan.rows.map((row) => row.detail).join(' / '));
    }
    return details;
}

describe('the plans for "this member in this channel"', () => {
    beforeEach(async () => {
        // Some history to plan over: the member and others, in the channel and a thread.
        for (let minute = 0; minute < 30; minute += 1) {
            await record({ userId: minute % 2 === 0 ? 'member-1' : 'member-2', occurredAt: at(minute) });
            await record({ channelId: THREAD_ID, parentChannelId: CHANNEL_ID, occurredAt: at(minute) });
        }
    });

    it('seeks the member-and-channel indexes for the last message', async () => {
        const plans = await plannedIndexes((repo) =>
            repo.findLastMessageAt({ guildId: GUILD_ID, userId: 'member-1', channelId: CHANNEL_ID })
        );

        expect(plans).toHaveLength(2);
        expect(plans.join(' | ')).toContain('activity_events_guild_channel_user_occurred_idx');
        expect(plans.join(' | ')).toContain('activity_events_guild_parent_channel_user_occurred_idx');
    });

    it('seeks the member-and-channel indexes for the last message inside a span', async () => {
        const plans = await plannedIndexes((repo) => repo.findLastMessageBetween({ ...SPAN, channelId: CHANNEL_ID }));

        expect(plans).toHaveLength(2);
        expect(plans.join(' | ')).toContain('activity_events_guild_channel_user_occurred_idx');
        expect(plans.join(' | ')).toContain('activity_events_guild_parent_channel_user_occurred_idx');
        // Read newest-first off the index, not gathered and sorted.
        expect(plans.join(' | ')).not.toContain('TEMP B-TREE');
    });

    it('seeks the member index for the last message anywhere inside a span', async () => {
        const plans = await plannedIndexes((repo) => repo.findLastMessageBetween(SPAN));

        expect(plans).toEqual([expect.stringContaining('activity_events_guild_user_occurred_idx')]);
        expect(plans.join(' | ')).not.toContain('TEMP B-TREE');
    });
});
