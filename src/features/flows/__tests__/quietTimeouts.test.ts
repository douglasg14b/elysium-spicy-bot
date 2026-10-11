import type { Client } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { activityEventsRepo } from '../../../features-system/activity';
import { database } from '../../../features-system/data-persistence/database';
import { migrateTestDatabase } from '../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import { ACTION_DELAY, block as delayBlock, delayConfigSchema } from '../blocks/actionDelay';
import { promptConfigSchema } from '../blocks/actionPrompt';
import { ACTION_SEND_DM } from '../blocks/actionSendDM';
import { waitForEventConfigSchema } from '../blocks/actionWaitForEvent';
import { ensureBlocksDiscovered } from '../blocks/registry';
import { TRIGGER_MEMBER_JOIN } from '../blocks/triggerMemberJoin';
import { RESUME_TIMEOUT, type FlowRunContext, type FlowRunSeed } from '../blocks/types';
import { FLOW_RUN_POLL_BATCH_SIZE } from '../constants';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../data/flowGraph';
import { flowRunsRepo } from '../data/flowRunsRepo';
import type { FlowQuietWindow } from '../data/flowRunsSchema';
import { executeFlow } from '../engine/executor';

/**
 * Timed parks whose deadline counts from the last message — against the real migrated
 * schema, the real repos and the real scheduler. Only the resume itself is stubbed,
 * because what is under test is whether the scheduler resumes at all.
 */

const resumeFlowRun = vi.fn();
const failParkedRun = vi.fn();

vi.mock('../engine/flowRunResume', () => ({
    resumeFlowRun: (...args: unknown[]) => resumeFlowRun(...args),
    failParkedRun: (...args: unknown[]) => failParkedRun(...args),
}));

const { runFlowRunTick, resetFlowRunSchedulerForTests } = await import('../engine/flowRunScheduler');

const GUILD_ID = 'guild-1';
const MEMBER_ID = 'member-1';
const CHANNEL_ID = 'channel-1';
const HOUR = 3_600_000;
const MINUTE = 60_000;
const READY_CLIENT = { user: { id: 'bot-1' } } as unknown as Client;
const DEPENDENCIES = {
    flowRunsRepo,
    activityEventsRepo,
    isBackfillPending: () => false,
    afterBackfill: (callback: () => void) => callback(),
};

/** A run that parked an hour ago on a one-hour window, so it is due now. */
async function parkDueRun(quietWindow: FlowQuietWindow | null, options: { aboutNobody?: boolean } = {}) {
    return flowRunsRepo.create({
        flowId: 'flow-1',
        guildId: GUILD_ID,
        contextSnapshot: options.aboutNobody ? { guildId: GUILD_ID } : { guildId: GUILD_ID, userId: MEMBER_ID },
        resumeNodeId: 'wait',
        wakeAt: new Date(Date.now() - MINUTE),
        quietWindow,
        visitsUsed: 3,
        log: [{ nodeId: 'wait', type: 'action.delay', kind: 'action', status: 'ok' }],
    });
}

async function said(options: { userId?: string; minutesAgo: number; kind?: 'message' | 'reaction' }) {
    await activityEventsRepo.record({
        guildId: GUILD_ID,
        userId: options.userId ?? MEMBER_ID,
        channelId: CHANNEL_ID,
        parentChannelId: null,
        messageId: null,
        kind: options.kind ?? 'message',
        occurredAt: new Date(Date.now() - options.minutesAgo * MINUTE),
    });
}

beforeAll(async () => {
    await migrateTestDatabase();
});

beforeEach(async () => {
    vi.clearAllMocks();
    resetFlowRunSchedulerForTests();
    resumeFlowRun.mockResolvedValue({ status: 'completed' });
    await database.deleteFrom('flow_runs').execute();
    await database.deleteFrom('activity_events').execute();
});

afterEach(() => {
    resetFlowRunSchedulerForTests();
});

describe('the scheduler on a park with a quiet window', () => {
    const memberWindow: FlowQuietWindow = { durationMs: HOUR, who: 'member', channelId: CHANNEL_ID };

    it('pushes the deadline back instead of waking the run when the member spoke within it', async () => {
        const run = await parkDueRun(memberWindow);
        await said({ minutesAgo: 10 });
        const [lastMessage] = await database.selectFrom('activity_events').select('occurredAt').execute();

        await runFlowRunTick(READY_CLIENT, DEPENDENCIES);

        expect(resumeFlowRun).not.toHaveBeenCalled();
        const after = await flowRunsRepo.getByRunId(run.runId);
        expect(after?.status).toBe('suspended');
        expect(after?.wakeAt).toEqual(new Date(lastMessage!.occurredAt.getTime() + HOUR));
        // A deferral is not a visit and writes nothing to the run's log.
        expect(after?.visitsUsed).toBe(run.visitsUsed);
        expect(after?.log).toEqual(run.log);
    });

    it("ends a run about nobody whose window counts the member's messages, rather than retrying it", async () => {
        // Save-time validation keeps this from parking at all — the option needs a
        // member — so it is a regression guard. A throw would leave the run parked and
        // retried every tick forever; it is failed by name instead.
        failParkedRun.mockResolvedValue({ status: 'failed', error: 'about nobody' });
        const run = await parkDueRun(memberWindow, { aboutNobody: true });

        await runFlowRunTick(READY_CLIENT, DEPENDENCIES);

        expect(resumeFlowRun).not.toHaveBeenCalled();
        expect(failParkedRun).toHaveBeenCalledTimes(1);
        expect(failParkedRun).toHaveBeenCalledWith(
            READY_CLIENT,
            expect.objectContaining({ runId: run.runId }),
            expect.stringMatching(/about nobody, so there is no member whose messages to count/),
            { wakeAt: run.wakeAt, resumeNodeId: run.resumeNodeId }
        );
    });

    it('wakes the run on its timeout when nobody has spoken', async () => {
        await parkDueRun(memberWindow);

        await runFlowRunTick(READY_CLIENT, DEPENDENCIES);

        expect(resumeFlowRun).toHaveBeenCalledWith(READY_CLIENT, expect.anything(), RESUME_TIMEOUT);
    });

    it('wakes the run when the last message is older than the window', async () => {
        await parkDueRun(memberWindow);
        await said({ minutesAgo: 90 });

        await runFlowRunTick(READY_CLIENT, DEPENDENCIES);

        expect(resumeFlowRun).toHaveBeenCalledTimes(1);
    });

    it('does not let a reaction hold the run open', async () => {
        await parkDueRun(memberWindow);
        await said({ minutesAgo: 5, kind: 'reaction' });

        await runFlowRunTick(READY_CLIENT, DEPENDENCIES);

        expect(resumeFlowRun).toHaveBeenCalledTimes(1);
    });

    it("counts someone else's message for anyone, and not for the member", async () => {
        const forMember = await parkDueRun(memberWindow);
        const forAnyone = await parkDueRun({ durationMs: HOUR, who: 'anyone', channelId: CHANNEL_ID });
        await said({ userId: 'member-2', minutesAgo: 5 });

        await runFlowRunTick(READY_CLIENT, DEPENDENCIES);

        const resumed = resumeFlowRun.mock.calls.map((call) => (call[1] as { runId: string }).runId);
        expect(resumed).toEqual([forMember.runId]);
        expect((await flowRunsRepo.getByRunId(forAnyone.runId))?.wakeAt?.getTime()).toBeGreaterThan(Date.now());
    });

    it('leaves the run parked when the lookup fails, rather than timing it out', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const run = await parkDueRun(memberWindow);
        const failing = {
            ...DEPENDENCIES,
            activityEventsRepo: {
                findLastMessageAt: vi.fn().mockRejectedValue(new Error('database down')),
                findLastMessageBetween: vi.fn(),
            },
        };

        await runFlowRunTick(READY_CLIENT, failing);

        expect(resumeFlowRun).not.toHaveBeenCalled();
        expect((await flowRunsRepo.getByRunId(run.runId))?.status).toBe('suspended');
    });

    it('wakes a park with no window exactly as before, without asking about messages', async () => {
        await parkDueRun(null);
        await said({ minutesAgo: 1 });
        const lookup = vi.spyOn(activityEventsRepo, 'findLastMessageAt');

        await runFlowRunTick(READY_CLIENT, DEPENDENCIES);

        expect(resumeFlowRun).toHaveBeenCalledTimes(1);
        expect(lookup).not.toHaveBeenCalled();
        lookup.mockRestore();
    });
});

describe('the scheduler while activity is restoring messages missed during an outage', () => {
    const memberWindow: FlowQuietWindow = { durationMs: HOUR, who: 'member', channelId: CHANNEL_ID };

    /** Scheduler dependencies whose backfill is pending until the test says otherwise. */
    function withBackfill() {
        const backfill = { pending: true };
        return { backfill, dependencies: { ...DEPENDENCIES, isBackfillPending: () => backfill.pending } };
    }

    function resumedRunIds(): string[] {
        return resumeFlowRun.mock.calls.map((call) => (call[1] as { runId: string }).runId);
    }

    it('holds a due quiet-window run with its deadline untouched, and still resumes a plain delay', async () => {
        const quietRun = await parkDueRun(memberWindow);
        const plainRun = await parkDueRun(null);
        const { dependencies } = withBackfill();

        await runFlowRunTick(READY_CLIENT, dependencies);

        // Without the hold, the quiet run times out here on history that is still missing.
        expect(resumedRunIds()).toEqual([plainRun.runId]);
        const held = await flowRunsRepo.getByRunId(quietRun.runId);
        expect(held?.status).toBe('suspended');
        expect(held?.wakeAt).toEqual(quietRun.wakeAt);
    });

    it('does not let a full batch of held runs starve a plain delay due after them', async () => {
        // Older than the plain run, so they fill the oldest-first batch if fetched at all.
        for (let index = 0; index < FLOW_RUN_POLL_BATCH_SIZE; index += 1) {
            const held = await parkDueRun(memberWindow);
            await database
                .updateTable('flow_runs')
                .set({ wakeAt: new Date(Date.now() - HOUR).toISOString() })
                .where('runId', '=', held.runId)
                .execute();
        }
        const plainRun = await parkDueRun(null);
        const { dependencies } = withBackfill();

        await runFlowRunTick(READY_CLIENT, dependencies);

        expect(resumedRunIds()).toEqual([plainRun.runId]);
    });

    it('defers the held run on what the backfill restored, once it has finished', async () => {
        const quietRun = await parkDueRun(memberWindow);
        const { backfill, dependencies } = withBackfill();
        await runFlowRunTick(READY_CLIENT, dependencies);

        // The backfill recovers a message the member sent during the outage, then clears.
        await said({ minutesAgo: 10 });
        backfill.pending = false;
        await runFlowRunTick(READY_CLIENT, dependencies);

        const [lastMessage] = await database.selectFrom('activity_events').select('occurredAt').execute();
        expect(resumeFlowRun).not.toHaveBeenCalled();
        expect((await flowRunsRepo.getByRunId(quietRun.runId))?.wakeAt).toEqual(
            new Date(lastMessage!.occurredAt.getTime() + HOUR)
        );
    });

    it('times the held run out as before once the backfill finds nothing', async () => {
        const quietRun = await parkDueRun(memberWindow);
        const { backfill, dependencies } = withBackfill();
        await runFlowRunTick(READY_CLIENT, dependencies);

        backfill.pending = false;
        await runFlowRunTick(READY_CLIENT, dependencies);

        expect(resumedRunIds()).toEqual([quietRun.runId]);
        expect(resumeFlowRun).toHaveBeenCalledWith(READY_CLIENT, expect.anything(), RESUME_TIMEOUT);
    });
});

describe('deferWake', () => {
    it('loses to a claim that landed between reading the run and deferring it', async () => {
        await parkDueRun({ durationMs: HOUR, who: 'member' });
        const [due] = await flowRunsRepo.findDue(new Date());
        await flowRunsRepo.claimForResume(due!.runId);

        const moved = await flowRunsRepo.deferWake(due!.runId, due!.wakeAt!, new Date(Date.now() + HOUR));

        expect(moved).toBe(false);
        const after = await flowRunsRepo.getByRunId(due!.runId);
        expect(after?.status).toBe('running');
        expect(after?.wakeAt).toEqual(due!.wakeAt);
    });

    it('loses to a re-park that moved the deadline', async () => {
        await parkDueRun({ durationMs: HOUR, who: 'member' });
        const [due] = await flowRunsRepo.findDue(new Date());
        const reparkedAt = new Date(Date.now() + 2 * HOUR);
        await flowRunsRepo.claimForResume(due!.runId);
        await flowRunsRepo.park(due!.runId, {
            resumeNodeId: 'wait',
            wakeAt: reparkedAt,
            visitsUsed: 4,
            log: [],
            variables: {},
        });

        expect(await flowRunsRepo.deferWake(due!.runId, due!.wakeAt!, new Date(Date.now() + HOUR))).toBe(false);
        expect((await flowRunsRepo.getByRunId(due!.runId))?.wakeAt).toEqual(reparkedAt);
    });

    it('moves the deadline of a run still parked on the wake it was read with', async () => {
        await parkDueRun({ durationMs: HOUR, who: 'member' });
        const [due] = await flowRunsRepo.findDue(new Date());
        const later = new Date(Date.now() + HOUR);

        expect(await flowRunsRepo.deferWake(due!.runId, due!.wakeAt!, later)).toBe(true);
        expect((await flowRunsRepo.getByRunId(due!.runId))?.wakeAt).toEqual(later);
    });
});

describe('the stored window', () => {
    it('round-trips as an object, and is cleared by a re-park without one and by a finish', async () => {
        const window: FlowQuietWindow = { durationMs: HOUR, who: 'anyone', channelId: CHANNEL_ID };
        const run = await parkDueRun(window);
        expect(run.quietWindow).toEqual(window);

        await flowRunsRepo.claimForResume(run.runId);
        const reparked = await flowRunsRepo.park(run.runId, {
            resumeNodeId: 'wait',
            wakeAt: new Date(Date.now() + HOUR),
            visitsUsed: 4,
            log: [],
            variables: {},
        });
        expect(reparked.quietWindow).toBeNull();

        await flowRunsRepo.claimForResume(run.runId);
        await flowRunsRepo.park(run.runId, {
            resumeNodeId: 'wait',
            wakeAt: new Date(Date.now() + HOUR),
            quietWindow: window,
            visitsUsed: 5,
            log: [],
            variables: {},
        });
        await flowRunsRepo.claimForResume(run.runId);
        const finished = await flowRunsRepo.complete(run.runId);
        expect(finished.quietWindow).toBeNull();
    });
});

describe('parking through the executor', () => {
    beforeAll(ensureBlocksDiscovered);

    /** Join → Delay (counting from the member's last message) → DM. */
    function quietDelayGraph(delayData: Record<string, unknown>): FlowGraph {
        return {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                { id: 'trigger', type: TRIGGER_MEMBER_JOIN, position: { x: 0, y: 0 }, data: {} },
                { id: 'wait', type: ACTION_DELAY, position: { x: 200, y: 0 }, data: delayData },
                { id: 'dm', type: ACTION_SEND_DM, position: { x: 400, y: 0 }, data: { message: 'Still there?' } },
            ],
            edges: [
                { id: 'e1', source: 'trigger', target: 'wait' },
                { id: 'e2', source: 'wait', target: 'dm' },
            ],
        };
    }

    function seedIn(guild: Record<string, unknown>): FlowRunSeed {
        return {
            client: {},
            guild: { id: GUILD_ID, ...guild },
            subject: { id: MEMBER_ID },
            actor: { id: MEMBER_ID },
            variables: {},
        } as unknown as FlowRunSeed;
    }

    it('stores the window a block parked with on the new run', async () => {
        const result = await executeFlow(
            'flow-1',
            quietDelayGraph({ durationMs: HOUR, timeoutCountsFrom: 'memberMessage' }),
            'trigger',
            seedIn({})
        );

        expect(result.status).toBe('success');
        const [row] = await database.selectFrom('flow_runs').select('runId').execute();
        expect((await flowRunsRepo.getByRunId(row!.runId))?.quietWindow).toEqual({ durationMs: HOUR, who: 'member' });
    });

    it('refuses to park on a channel the bot cannot read, rather than never hearing anyone there', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const hidden = { permissionsFor: () => ({ has: () => false }) };

        const result = await executeFlow(
            'flow-1',
            quietDelayGraph({ durationMs: HOUR, timeoutCountsFrom: 'anyMessage', quietChannelId: CHANNEL_ID }),
            'trigger',
            seedIn({ channels: { cache: new Map([[CHANNEL_ID, hidden]]) }, members: { me: {} } })
        );

        expect(result).toMatchObject({ status: 'error', error: expect.stringContaining("can't see") });
        expect(await database.selectFrom('flow_runs').selectAll().execute()).toEqual([]);
    });
});

describe('the time-limit options', () => {
    it("refuses anyone's messages without a channel, naming the channel field", () => {
        const parsed = delayConfigSchema.safeParse({ durationMs: HOUR, timeoutCountsFrom: 'anyMessage' });

        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues).toEqual([
            expect.objectContaining({ path: ['quietChannelId'], message: expect.stringContaining('needs a channel') }),
        ]);
    });

    it('refuses counting from a message when there is no time limit to count', () => {
        const refusal = [
            expect.objectContaining({ path: ['timeoutCountsFrom'], message: expect.stringContaining('no time limit') }),
        ];

        const question = promptConfigSchema.safeParse({
            question: 'Well?',
            choices: ['Yes'],
            timeoutCountsFrom: 'memberMessage',
        });
        const wait = waitForEventConfigSchema.safeParse({ eventKind: 'reactionAdd', timeoutCountsFrom: 'memberMessage' });

        expect(question.error?.issues).toEqual(refusal);
        expect(wait.error?.issues).toEqual(refusal);
    });

    it('reads a graph saved before the option existed as counting from the start', () => {
        const parsed = waitForEventConfigSchema.parse({ eventKind: 'reactionAdd', timeoutMs: HOUR });

        expect(parsed.timeoutCountsFrom).toBe('waitStart');
    });

    it('parks with the window the author asked for, and none for the default', async () => {
        const context = {} as FlowRunContext;
        const quiet = delayConfigSchema.parse({ durationMs: HOUR, timeoutCountsFrom: 'memberMessage', quietChannelId: '' });
        const plain = delayConfigSchema.parse({ durationMs: HOUR });

        const quietOutcome = await delayBlock.run(quiet, context);
        const plainOutcome = await delayBlock.run(plain, context);

        // An empty channel is a cleared picker: anywhere in the server.
        expect(quietOutcome).toMatchObject({ kind: 'suspend', suspension: { quietWindow: { durationMs: HOUR, who: 'member' } } });
        expect(quietOutcome.kind === 'suspend' && quietOutcome.suspension.quietWindow).not.toHaveProperty('channelId');
        expect(plainOutcome.kind === 'suspend' && plainOutcome.suspension.quietWindow).toBeUndefined();
    });
});
