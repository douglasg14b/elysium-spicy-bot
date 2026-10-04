import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { activityEventsRepo, type RecordActivityEventInput } from '../../../../../features-system/activity/data/activityEventsRepo';
import { database } from '../../../../../features-system/data-persistence/database';
import { migrateTestDatabase } from '../../../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import { ensureBlocksDiscovered } from '../../registry';
import { VARIABLE_NAME_MAX_LENGTH } from '../../variableName';
import type { FlowRunContext, FlowVariableValue } from '../../types';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../../data/flowGraph';
import { validateNodeData } from '../../../engine/nodeDataValidation';
import type { FlowStepOutcome } from '../../../engine/stepOutcome';
import { CONDITION_TIME_SINCE, block, parseStrictTime, timeSinceConfigSchema, type TimeSinceSource } from '../index';

/**
 * Time Since answers Yes, No or No record from every source, on both sides of the
 * boundary, and fails by name on a saved value that is not a time.
 *
 * Messages are read from the real activity record on the real migrated schema, so the
 * thread case proves what the block promises — a reply in a thread counts toward its
 * parent — rather than what a stubbed repo was told to return. The clock is pinned with
 * a fake `Date` only, so the boundary is exact to the millisecond.
 */

const GUILD_ID = 'guild-1';
const MEMBER_ID = 'member-1';
const CHANNEL_ID = 'channel-1';
const OTHER_CHANNEL_ID = 'channel-2';
const THREAD_ID = 'thread-1';
const HOUR = 60 * 60 * 1000;
const DURATION = 2 * HOUR;
const NOW = new Date('2026-10-02T12:00:00.000Z');

/** A time `offset` milliseconds before now. */
function ago(offset: number): Date {
    return new Date(NOW.getTime() - offset);
}

/**
 * A guild whose cache holds `visible` channels, readable by the bot, and `hidden` ones it
 * cannot view. Any other channel is absent from the cache — deleted.
 */
function guildSeeing(visible: readonly string[], hidden: readonly string[] = []): FlowRunContext['guild'] {
    const readable = { permissionsFor: () => ({ has: () => true }) };
    const unreadable = { permissionsFor: () => ({ has: () => false }) };
    return {
        id: GUILD_ID,
        members: { me: { id: 'bot-1' } },
        channels: {
            cache: new Map([
                ...visible.map((channelId) => [channelId, readable] as const),
                ...hidden.map((channelId) => [channelId, unreadable] as const),
            ]),
        },
    } as unknown as FlowRunContext['guild'];
}

interface ContextOverrides {
    readonly joinedAt?: Date | null;
    readonly startedAt?: Date;
    readonly variables?: Readonly<Record<string, FlowVariableValue>>;
    readonly visibleChannels?: readonly string[];
    readonly hiddenChannels?: readonly string[];
}

function contextWith(overrides: ContextOverrides = {}): FlowRunContext {
    return {
        client: {} as FlowRunContext['client'],
        guild: guildSeeing(overrides.visibleChannels ?? [CHANNEL_ID, OTHER_CHANNEL_ID], overrides.hiddenChannels),
        subject: {
            id: MEMBER_ID,
            joinedAt: overrides.joinedAt === undefined ? null : overrides.joinedAt,
        } as unknown as FlowRunContext['subject'],
        runId: 'run-1',
        nodeId: 'since',
        chainDepth: 1,
        variables: overrides.variables ?? {},
        ...(overrides.startedAt ? { startedAt: overrides.startedAt } : {}),
        setOutput: () => {},
    };
}

/** Run the block on raw node data, parsed first as the executor parses it. */
async function answer(data: Record<string, unknown>, overrides: ContextOverrides = {}): Promise<FlowStepOutcome> {
    return block.run(timeSinceConfigSchema.parse({ durationMs: DURATION, ...data }), contextWith(overrides));
}

async function said(overrides: Partial<RecordActivityEventInput>): Promise<void> {
    await activityEventsRepo.record({
        guildId: GUILD_ID,
        userId: MEMBER_ID,
        channelId: CHANNEL_ID,
        parentChannelId: null,
        messageId: null,
        kind: 'message',
        occurredAt: NOW,
        ...overrides,
    });
}

beforeAll(async () => {
    await migrateTestDatabase();
    await ensureBlocksDiscovered();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
});

afterAll(() => {
    vi.useRealTimers();
});

beforeEach(async () => {
    await database.deleteFrom('activity_events').execute();
});

/**
 * Each source, with how to put its reference time at a given instant: the node data
 * that picks it, and the record or context that answers it.
 */
const SOURCES: readonly {
    readonly source: TimeSinceSource;
    readonly data: Record<string, unknown>;
    readonly at: (when: Date) => Promise<ContextOverrides>;
}[] = [
    {
        source: 'memberMessage',
        data: {},
        at: async (when) => {
            await said({ occurredAt: when });
            return {};
        },
    },
    {
        source: 'memberMessage',
        data: { channelId: CHANNEL_ID },
        at: async (when) => {
            await said({ occurredAt: when });
            // Later, but somewhere else, so it must not count.
            await said({ channelId: OTHER_CHANNEL_ID, occurredAt: NOW });
            return {};
        },
    },
    {
        source: 'channelMessage',
        data: { channelId: CHANNEL_ID },
        at: async (when) => {
            await said({ userId: 'member-2', occurredAt: when });
            return {};
        },
    },
    { source: 'memberJoined', data: {}, at: async (when) => ({ joinedAt: when }) },
    { source: 'runStarted', data: {}, at: async (when) => ({ startedAt: when }) },
    {
        source: 'variable',
        data: { timeVariable: 'seenAt' },
        at: async (when) => ({ variables: { seenAt: when.toISOString() } }),
    },
];

describe.each(SOURCES)('measuring from $source $data', ({ source, data, at }) => {
    it('says Yes to "at least" exactly at the boundary, and No a millisecond short of it', async () => {
        expect(await answer({ ...data, source, comparison: 'atLeast' }, await at(ago(DURATION)))).toEqual({
            kind: 'continue',
            handle: 'true',
        });
        await database.deleteFrom('activity_events').execute();
        expect(await answer({ ...data, source, comparison: 'atLeast' }, await at(ago(DURATION - 1)))).toEqual({
            kind: 'continue',
            handle: 'false',
        });
    });

    it('says No to "less than" exactly at the boundary, and Yes a millisecond short of it', async () => {
        expect(await answer({ ...data, source, comparison: 'lessThan' }, await at(ago(DURATION)))).toEqual({
            kind: 'continue',
            handle: 'false',
        });
        await database.deleteFrom('activity_events').execute();
        expect(await answer({ ...data, source, comparison: 'lessThan' }, await at(ago(DURATION - 1)))).toEqual({
            kind: 'continue',
            handle: 'true',
        });
    });
});

describe('nothing to measure from', () => {
    const NO_RECORD = { kind: 'continue', handle: 'noRecord' };

    it('leaves by No record when nobody has said anything', async () => {
        await said({ userId: 'member-2', channelId: OTHER_CHANNEL_ID });

        expect(await answer({ source: 'memberMessage' })).toEqual(NO_RECORD);
        expect(await answer({ source: 'channelMessage', channelId: CHANNEL_ID })).toEqual(NO_RECORD);
    });

    it('leaves by No record for a partial member, who has no join date', async () => {
        expect(await answer({ source: 'memberJoined' }, { joinedAt: null })).toEqual(NO_RECORD);
    });

    it('leaves by No record for a run parked before runs recorded their start', async () => {
        expect(await answer({ source: 'runStarted' })).toEqual(NO_RECORD);
    });

    it('leaves by No record for a saved time that is unset, null or empty', async () => {
        const data = { source: 'variable', timeVariable: 'seenAt' };

        expect(await answer(data)).toEqual(NO_RECORD);
        expect(await answer(data, { variables: { seenAt: null } })).toEqual(NO_RECORD);
        expect(await answer(data, { variables: { seenAt: '' } })).toEqual(NO_RECORD);
    });
});

describe('a saved value that is not a time', () => {
    it.each([['tomorrow'], ['2026-10-02'], ['2026-10-02T12:00:00Z'], [1_759_406_400_000], [true]])(
        'fails the run by name for %j, never answering a branch',
        async (value) => {
            const outcome = await answer({ source: 'variable', timeVariable: 'seenAt' }, { variables: { seenAt: value } });

            expect(outcome).toEqual({
                kind: 'fail',
                error: `"seenAt" holds ${JSON.stringify(value)}, which is not a time. Save one with a Set Variable on Current time.`,
            });
        }
    );

    it('reads only the exact spelling Set Variable writes as a time', () => {
        expect(parseStrictTime('2026-10-02T12:00:00.000Z')).toEqual(NOW);
        expect(parseStrictTime('2026-10-02T12:00:00Z')).toBeUndefined();
        expect(parseStrictTime('not a date at all')).toBeUndefined();
        expect(parseStrictTime(NOW.getTime())).toBeUndefined();
    });
});

describe('messages in threads', () => {
    it("counts anyone's reply in a thread toward its parent channel", async () => {
        await said({ userId: 'member-2', channelId: THREAD_ID, parentChannelId: CHANNEL_ID, occurredAt: ago(HOUR) });

        expect(await answer({ source: 'channelMessage', channelId: CHANNEL_ID, comparison: 'lessThan' })).toEqual({
            kind: 'continue',
            handle: 'true',
        });
    });

    it("counts the member's own reply in a thread toward its parent channel", async () => {
        await said({ channelId: THREAD_ID, parentChannelId: CHANNEL_ID, occurredAt: ago(HOUR) });

        expect(await answer({ source: 'memberMessage', channelId: CHANNEL_ID, comparison: 'lessThan' })).toEqual({
            kind: 'continue',
            handle: 'true',
        });
    });
});

describe('a channel the bot cannot read', () => {
    it.each([['channelMessage'], ['memberMessage']] as const)(
        'fails on %s rather than answering No record from silence it cannot hear',
        async (source) => {
            await expect(
                answer({ source, channelId: CHANNEL_ID }, { visibleChannels: [], hiddenChannels: [CHANNEL_ID] })
            ).rejects.toThrow(
                /^"Messages in" is a channel the bot can't see \(channel-1\), so nothing said there is ever recorded.*Pick a channel the bot can read\.$/
            );
        }
    );

    it('says a channel missing from the cache no longer exists, rather than blaming permissions', async () => {
        // What a `{{var}}` recording a since-deleted channel resolves to.
        await expect(answer({ source: 'memberMessage', channelId: CHANNEL_ID }, { visibleChannels: [] })).rejects.toThrow(
            /^"Messages in" is a channel that no longer exists \(channel-1\), so nothing said there is ever recorded.*Pick one that does\.$/
        );
    });
});

describe('when No record is worth a warning', () => {
    it('warns about an unconnected No record only for the sources an ordinary run can reach it from', () => {
        expect(block.handles).toContainEqual({
            id: 'noRecord',
            label: 'No record',
            tone: 'caution',
            warnIfUnconnected: { whenField: 'source', equals: ['memberMessage', 'channelMessage', 'variable'] },
        });
    });
});

describe('what a save refuses', () => {
    /** member join -> one Time Since holding `data`, nothing wired after it. */
    function saveIssues(data: Record<string, unknown>): { field?: string; message: string }[] {
        const graph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                { id: 'trigger', type: 'trigger.memberJoin', position: { x: 0, y: 0 }, data: {} },
                { id: 'since', type: CONDITION_TIME_SINCE, position: { x: 1, y: 0 }, data },
            ],
            edges: [{ id: 'e1', source: 'trigger', target: 'since' }],
        } as FlowGraph;
        const result = validateNodeData(graph);
        return result.valid ? [] : result.issues.map(({ field, message }) => ({ field, message }));
    }

    it("refuses anyone's last message with no channel to look in", () => {
        expect(saveIssues({ source: 'channelMessage', durationMs: DURATION })).toEqual([
            {
                field: 'channelId',
                message: "Anyone's last message where? Pick a channel — the whole server is never quiet.",
            },
        ]);
    });

    it('refuses a saved time with none picked', () => {
        expect(saveIssues({ source: 'variable', durationMs: DURATION })).toEqual([
            { field: 'timeVariable', message: 'Pick which saved time to measure from.' },
        ]);
    });

    it('refuses a saved-time name longer than any block may write', () => {
        const name = (length: number) => ({ source: 'variable', durationMs: DURATION, timeVariable: 'a'.repeat(length) });

        expect(saveIssues(name(VARIABLE_NAME_MAX_LENGTH))).toEqual([]);
        expect(saveIssues(name(VARIABLE_NAME_MAX_LENGTH + 1)).map((issue) => issue.field)).toEqual(['timeVariable']);
    });

    it('judges only the inputs the source uses, so a stale one refuses nothing', () => {
        expect(saveIssues({ source: 'memberJoined', durationMs: DURATION, timeVariable: 'not.a.name' })).toEqual([]);
        expect(saveIssues({ source: 'memberMessage', durationMs: DURATION })).toEqual([]);
    });

    it('refuses a span past a year', () => {
        expect(saveIssues({ source: 'runStarted', durationMs: 366 * 24 * HOUR }).map((issue) => issue.field)).toEqual([
            'durationMs',
        ]);
    });
});
