import { ButtonStyle, ComponentType, type Client } from 'discord.js';
import { sql } from 'kysely';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION_PROMPT, PROMPT_TIMEOUT_HANDLE } from '../blocks/actionPrompt';
import { ensureBlocksDiscovered } from '../blocks/registry';
import { RESUME_EVENT, RESUME_TIMEOUT } from '../blocks/types';
import { flowGraphSchema, type FlowGraph } from '../data/flowGraph';
import { FlowRunsRepo } from '../data/flowRunsRepo';
import type { FlowRunEntity } from '../data/flowRunsSchema';
import type { FlowEntity } from '../data/flowsSchema';
import {
    createFlowRunsTestClient,
    createFlowRunsTestDb,
    insertPreM1FlowRunRow,
    type FlowRunsTestDb,
    type PreM1FlowRunRow,
} from '../../../features-system/data-persistence/__tests__/support/flowRunsTestDb';
import { rebuildResumeContext, resumeFlowRun } from '../engine/flowRunResume';
import { reclaimStrandedFlowRuns, resetFlowRunSchedulerForTests } from '../engine/flowRunScheduler';
import { up as createFlowRuns } from '../../../features-system/data-persistence/migrations/2026-09-12-Create_Flow_Runs';
import { up as settleFlowRunLifecycle } from '../../../features-system/data-persistence/migrations/2026-09-13-Settle_Flow_Run_Lifecycle';
import { up as addFlowRunVariables } from '../../../features-system/data-persistence/migrations/2026-09-14-Add_Flow_Run_Variables';
import { up as widenContextSnapshot } from '../../../features-system/data-persistence/migrations/2026-09-15-Widen_Flow_Run_Context_Snapshot';
import { up as addWaitMessage } from '../../../features-system/data-persistence/migrations/2026-09-16-Add_Flow_Run_Wait_Message';
import { sentCopy } from './support/sentCopy';
import preM1GraphJson from './fixtures/preM1Graph.json';
import preM1ParkedRunsJson from './fixtures/preM1ParkedRuns.json';

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';
const DELAY_PARKED_RUN = 'pre-m1-delay-parked';
const WAIT_PARKED_RUN = 'pre-m1-wait-parked';

/** The node each fixture run must land on, read straight off the committed graph. */
const DM_AFTER_DELAY = '2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901';
const WAIT_NODE = '3c4d5e6f-7081-4293-a4b5-c6d7e8f90123';
const TIMEOUT_DM = '5e6f7081-92a3-44b5-86d7-e8f901234567';

const PRE_M1_ROWS: readonly PreM1FlowRunRow[] = preM1ParkedRunsJson;

/**
 * A client the resume path can rebuild a run against.
 *
 * `channel` is optional because most cases here park nowhere — the pre-M1 rows
 * genuinely recorded no channel. Supplying one puts it in the guild's cache, which
 * is where `resolveSnapshotChannel` looks first, so a run that stored a channel id
 * resolves without a fetch.
 */
function makeClient(channel?: { id: string; messages: { fetch: ReturnType<typeof vi.fn> } }): {
    client: Client;
    userSend: ReturnType<typeof vi.fn>;
    rolesAdd: ReturnType<typeof vi.fn>;
} {
    const userSend = vi.fn().mockResolvedValue(undefined);
    const rolesAdd = vi.fn().mockResolvedValue(undefined);

    const member = {
        id: USER_ID,
        user: { id: USER_ID, send: userSend },
        roles: { add: rolesAdd, cache: { has: () => false } },
    };
    // `asGuildTextChannel` keeps anything that is text-based and not a DM, so the
    // stub has to answer both of those the way a guild text channel does.
    const cached = channel
        ? { ...channel, isDMBased: () => false, isTextBased: () => true }
        : undefined;
    const guild = {
        id: GUILD_ID,
        members: { fetch: vi.fn().mockResolvedValue(member) },
        channels: { cache: { get: (id: string) => (cached?.id === id ? cached : undefined) } },
    };

    return {
        client: {
            user: { id: 'bot-1' },
            guilds: { cache: { get: () => guild }, fetch: vi.fn().mockResolvedValue(guild) },
        } as unknown as Client,
        userSend,
        rolesAdd,
    };
}

/**
 * A run that was parked before M1 must resume to the same next node afterwards.
 *
 * Exactly one field of a pre-M1 row is rewritten — `status`, by the migration. The
 * suspension payload (`resumeNodeId`, `waitKind`, `waitConfig`, `visitsUsed`,
 * `log`) is read as written, with no translation on either side, which is why
 * these fixtures are committed verbatim rather than regenerated from live code.
 *
 * **`fixtures/preM1ParkedRuns.json` is frozen. Never regenerate it.** Its entire
 * value is that it was captured *before* the shapes it pins were changed — rows
 * with `entity_version: 1` and a two-key `context_snapshot`, written by builds
 * that had neither a `variables` column nor a `channelId`. Re-capturing it from
 * current code would leave every assertion here green while proving nothing at
 * all, because it would freeze post-migration rows and quietly void the
 * backward-compatibility guarantee this suite exists to hold. If a case here
 * fails, the change under test broke compatibility — the fixture is not the thing
 * to edit.
 */
// Resuming walks the graph, which reads the registry.
beforeAll(ensureBlocksDiscovered);

describe('runs parked before M1', () => {
    let testDb: FlowRunsTestDb;
    let repo: FlowRunsRepo;
    let flow: FlowEntity;

    beforeEach(async () => {
        // Build the pre-M1 table, fill it with pre-M1 rows, and only then migrate —
        // so the rows travel through the migration the way a real database's do.
        testDb = createFlowRunsTestClient();
        await createFlowRuns(testDb.db);
        for (const row of PRE_M1_ROWS) {
            await insertPreM1FlowRunRow(testDb.db, row);
        }
        await settleFlowRunLifecycle(testDb.db);
        // Every migration since, in order: a pre-M1 row has to survive the whole
        // chain, not merely the one that renamed its status.
        await addFlowRunVariables(testDb.db);
        await widenContextSnapshot(testDb.db);
        await addWaitMessage(testDb.db);

        repo = new FlowRunsRepo(testDb.db);
        // The committed graph must still satisfy the current schema untouched.
        const graph: FlowGraph = flowGraphSchema.parse(preM1GraphJson);
        flow = { flowId: 'pre-m1-flow', guildId: GUILD_ID, graph, enabled: true } as FlowEntity;
    });

    afterEach(async () => {
        resetFlowRunSchedulerForTests();
        await testDb.db.destroy();
    });

    const loadRun = async (runId: string): Promise<FlowRunEntity> => {
        const run = await repo.getByRunId(runId);
        if (!run) {
            throw new Error(`fixture run ${runId} was not inserted`);
        }
        return run;
    };

    const dependencies = (): { flowsRepo: { getByFlowId: ReturnType<typeof vi.fn> }; flowRunsRepo: FlowRunsRepo } => ({
        flowsRepo: { getByFlowId: vi.fn().mockResolvedValue(flow) },
        flowRunsRepo: repo,
    });

    it('carries the pre-M1 suspension payload through the migration untouched', async () => {
        const delayRun = await loadRun(DELAY_PARKED_RUN);
        const waitRun = await loadRun(WAIT_PARKED_RUN);

        expect(delayRun.status).toBe('suspended');
        expect(delayRun.resumeNodeId).toBe(DM_AFTER_DELAY);
        expect(delayRun.visitsUsed).toBe(3);
        expect(delayRun.log).toHaveLength(2);
        expect(delayRun.entityVersion).toBe(1);
        expect(delayRun.claimedAt).toBeNull();
        // A row parked before variables existed recorded none, and reads back
        // saying exactly that rather than as a null every caller has to guard.
        expect(delayRun.variables).toEqual({});
        // Likewise the channel: the snapshot is the two keys it was written with,
        // read back unchanged. `channelId` being optional is what lets a v1 row
        // parse under the widened schema with nothing rewritten and no tolerant
        // union — the migration leaves stored rows alone precisely so this stays
        // the untouched original.
        expect(delayRun.contextSnapshot).toEqual({ guildId: GUILD_ID, userId: USER_ID });
        expect(delayRun.contextSnapshot.channelId).toBeUndefined();

        expect(waitRun.status).toBe('suspended');
        expect(waitRun.resumeNodeId).toBe(WAIT_NODE);
        expect(waitRun.waitKind).toBe('memberJoin');
        expect(waitRun.waitConfig).toEqual({ eventKind: 'memberJoin', timeoutMs: 3_600_000 });
        expect(waitRun.visitsUsed).toBe(5);
    });

    it('rebuilds a pre-change row as a run that is nowhere, rather than failing it', async () => {
        // A row written before the snapshot carried a channel has no `channelId`,
        // so the resume path has nothing to resolve. That must come back as an
        // ordinary absent channel — the same state a gateway-started run has, and
        // one every block already handles — not a throw and not a failed run.
        const { client } = makeClient();

        const rebuilt = await rebuildResumeContext(client, await loadRun(DELAY_PARKED_RUN));

        if (!rebuilt.ok) {
            throw new Error(`a pre-change row should still rebuild, but: ${rebuilt.reason}`);
        }
        expect(rebuilt.context.channel).toBeUndefined();
        expect(rebuilt.context.subject.id).toBe(USER_ID);
    });

    it('resumes a delay-parked run at the node the delay pointed at', async () => {
        const { client, userSend } = makeClient();

        const outcome = await resumeFlowRun(client, await loadRun(DELAY_PARKED_RUN), RESUME_TIMEOUT, dependencies());

        expect(outcome.status).toBe('suspended');
        expect(sentCopy(userSend)).toContain('Still with us? Good.');

        // It ran the DM and then parked on the wait that follows it.
        const after = await loadRun(DELAY_PARKED_RUN);
        expect(after.resumeNodeId).toBe(WAIT_NODE);
        expect(after.waitKind).toBe('memberJoin');
        // The visit budget carried forward rather than resetting.
        expect(after.visitsUsed).toBeGreaterThan(3);
    });

    it('resumes a wait-parked run down its event branch', async () => {
        const { client, rolesAdd } = makeClient();

        const outcome = await resumeFlowRun(client, await loadRun(WAIT_PARKED_RUN), RESUME_EVENT, dependencies());

        expect(outcome.status).toBe('completed');
        expect(rolesAdd).toHaveBeenCalledWith('role-verified');
        expect((await loadRun(WAIT_PARKED_RUN)).status).toBe('completed');
    });

    it('resumes a wait-parked run down its timeout branch', async () => {
        const { client, userSend } = makeClient();

        const outcome = await resumeFlowRun(client, await loadRun(WAIT_PARKED_RUN), RESUME_TIMEOUT, dependencies());

        expect(outcome.status).toBe('completed');
        expect(sentCopy(userSend)).toContain('You took too long. Try again when you mean it.');
        // Named so a reader can see which branch the graph says that is.
        expect(flow.graph.edges.find((edge) => edge.sourceHandle === 'timeout')?.target).toBe(TIMEOUT_DM);
    });

    it('resumes a wait-parked run handed a choice', async () => {
        // No shipped block reads `index` yet — the prompt block is a later slice —
        // so this covers the engine accepting a choice end to end. That a block can
        // read the index is proven where a block can be written for it, in
        // `blockConformance.test.ts`.
        const { client, rolesAdd } = makeClient();

        const outcome = await resumeFlowRun(
            client,
            await loadRun(WAIT_PARKED_RUN),
            { kind: 'choice', index: 2 },
            dependencies()
        );

        expect(outcome.status).toBe('completed');
        expect(rolesAdd).toHaveBeenCalledWith('role-verified');
    });
});

/**
 * The claim, exercised against a real row rather than against a guard in
 * isolation: two resumers race one run, and a claim abandoned by a dead process
 * comes back.
 */
describe('the resume claim under contention', () => {
    let testDb: FlowRunsTestDb;
    let repo: FlowRunsRepo;
    let flow: FlowEntity;

    beforeEach(async () => {
        testDb = await createFlowRunsTestDb();
        repo = new FlowRunsRepo(testDb.db);
        flow = {
            flowId: 'pre-m1-flow',
            guildId: GUILD_ID,
            graph: flowGraphSchema.parse(preM1GraphJson),
            enabled: true,
        } as FlowEntity;
    });

    afterEach(async () => {
        resetFlowRunSchedulerForTests();
        await testDb.db.destroy();
    });

    /** A run parked on the delay's downstream DM, already due. */
    const parkDueRun = async (): Promise<FlowRunEntity> =>
        repo.create({
            flowId: 'pre-m1-flow',
            guildId: GUILD_ID,
            contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
            resumeNodeId: DM_AFTER_DELAY,
            wakeAt: new Date(Date.now() - 60_000),
            visitsUsed: 3,
        });

    it('advances a run exactly once when two resumers arrive together', async () => {
        const { client, userSend } = makeClient();
        const run = await parkDueRun();
        const dependencies = { flowsRepo: { getByFlowId: vi.fn().mockResolvedValue(flow) }, flowRunsRepo: repo };

        // A timeout and a moderator's click, landing on the same row at once.
        const outcomes = await Promise.all([
            resumeFlowRun(client, run, RESUME_TIMEOUT, dependencies),
            resumeFlowRun(client, run, RESUME_TIMEOUT, dependencies),
        ]);

        const statuses = outcomes.map((outcome) => outcome.status).sort();
        expect(statuses).toEqual(['skipped', 'suspended']);
        // The side effect happened once, which is the assertion that actually matters.
        expect(userSend).toHaveBeenCalledTimes(1);
    });

    it('reclaims a claim left behind by a killed process, then resumes it once', async () => {
        const { client, userSend } = makeClient();
        const run = await parkDueRun();

        // Simulate SIGKILL mid-resume: the claim is taken and never given back. No
        // backdating — a process dying seconds after claiming is the common case,
        // and recovery must not depend on the claim being old.
        await repo.claimForResume(run.runId);

        // Invisible to the poller while the claim stands.
        expect(await repo.findDue(new Date())).toHaveLength(0);

        expect(await reclaimStrandedFlowRuns({ flowRunsRepo: repo })).toBe(1);

        const reclaimed = await repo.getByRunId(run.runId);
        expect(reclaimed?.status).toBe('suspended');
        if (!reclaimed) {
            throw new Error('the reclaimed run disappeared');
        }

        const dependencies = { flowsRepo: { getByFlowId: vi.fn().mockResolvedValue(flow) }, flowRunsRepo: repo };
        const outcome = await resumeFlowRun(client, reclaimed, RESUME_TIMEOUT, dependencies);

        expect(outcome.status).toBe('suspended');
        expect(userSend).toHaveBeenCalledTimes(1);
    });

    it('makes a reclaimed run visible to the poller again', async () => {
        const run = await parkDueRun();
        await repo.claimForResume(run.runId);

        await reclaimStrandedFlowRuns({ flowRunsRepo: repo });

        const due = await repo.findDue(new Date());
        expect(due).toHaveLength(1);
        expect(due[0]?.runId).toBe(run.runId);
    });

    it('gives the claim back when a resumer blows up for a reason unrelated to the run', async () => {
        const { client } = makeClient();
        const run = await parkDueRun();
        const dependencies = {
            flowsRepo: { getByFlowId: vi.fn().mockRejectedValue(new Error('db down')) },
            flowRunsRepo: repo,
        };

        await expect(resumeFlowRun(client, run, RESUME_TIMEOUT, dependencies)).rejects.toThrow('db down');

        // Back in the pool, so the very next poll retries — no restart needed.
        const after = await repo.getByRunId(run.runId);
        expect(after?.status).toBe('suspended');
        expect(after?.claimedAt).toBeNull();
        expect(await repo.findDue(new Date())).toHaveLength(1);
    });
});

/**
 * A stale control cannot advance a run, proven against a real row.
 *
 * These are the cases slice D exists for, and they are the reason the claim grew a
 * park-scoped variant. The hazard they cover is specific and is **not** the plain
 * two-resumers race above: that one is settled by `status = 'suspended'` alone,
 * because both resumers are contending for the same park. Here the two presses are
 * on *different* parks that look identical in every stored column — same run, same
 * `resumeNodeId`, both `suspended` — which is what a graph that loops back to its
 * own question produces, and what nothing before this slice could tell apart.
 *
 * Driven through `resumeFlowRun` and the real `FlowRunsRepo` rather than by
 * calling the guard directly, because what is being proven is that the guard is
 * *in the write path*. A check asserted in isolation would pass with the claim
 * still node-blind.
 */
describe('a control from a closed park', () => {
    const QUESTION_NODE = '7a8b9c0d-1e2f-4304-8516-27384950a1b2';
    const AFTER_TIMEOUT = '8b9c0d1e-2f30-4415-9627-384950a1b2c3';
    const FIRST_ASKING = 'message-first';
    const SECOND_ASKING = 'message-second';
    const CHANNEL_ID = 'channel-1';

    let testDb: FlowRunsTestDb;
    let repo: FlowRunsRepo;

    beforeEach(async () => {
        testDb = await createFlowRunsTestDb();
        repo = new FlowRunsRepo(testDb.db);
    });

    afterEach(async () => {
        resetFlowRunSchedulerForTests();
        await testDb.db.destroy();
    });

    /**
     * A question with somewhere to go when nobody answers.
     *
     * The timeout handle has to be wired, or the executor completes the run at the
     * park instead of holding it — which is `reachable` in `executeFlowSegment`
     * doing its job, and would make this case prove nothing about the timeout
     * branch.
     */
    const questionFlow = (): FlowEntity =>
        ({
            flowId: 'question-flow',
            guildId: GUILD_ID,
            enabled: true,
            graph: flowGraphSchema.parse({
                version: 1,
                nodes: [
                    {
                        id: QUESTION_NODE,
                        type: ACTION_PROMPT,
                        position: { x: 0, y: 0 },
                        data: { question: 'Well?', choices: ['Yes', 'No'] },
                    },
                    {
                        id: AFTER_TIMEOUT,
                        type: 'action.sendDM',
                        position: { x: 220, y: 0 },
                        data: { message: 'You left it too long.' },
                    },
                ],
                edges: [
                    {
                        id: 'edge-question-timeout',
                        source: QUESTION_NODE,
                        sourceHandle: PROMPT_TIMEOUT_HANDLE,
                        target: AFTER_TIMEOUT,
                    },
                ],
            }),
        }) as FlowEntity;

    /** A run parked on a question, waiting on the message its buttons are on. */
    const parkOnQuestion = async (waitMessageId: string): Promise<FlowRunEntity> =>
        repo.create({
            flowId: 'question-flow',
            guildId: GUILD_ID,
            contextSnapshot: { guildId: GUILD_ID, userId: USER_ID, channelId: CHANNEL_ID },
            resumeNodeId: QUESTION_NODE,
            waitMessageId,
        });

    it('refuses a press from an earlier asking at the node the run is parked on again', async () => {
        const run = await parkOnQuestion(FIRST_ASKING);

        // The run answered, carried on, looped back, and asked again — so it is
        // once more `suspended` at the very same node. Every column a press could
        // be checked against is what it was, except the message.
        await repo.claimForResume(run.runId);
        await repo.park(run.runId, {
            resumeNodeId: QUESTION_NODE,
            waitMessageId: SECOND_ASKING,
            visitsUsed: 2,
            log: [],
            variables: {},
        });

        // Somebody presses a button on the *first* message, which is still sitting
        // in the channel. It names a run that is parked, at the node it expects.
        const stale = await repo.claimForResume(run.runId, FIRST_ASKING);
        expect(stale).toBeNull();

        // And the live one still works, so this refuses the stale press rather
        // than wedging the question.
        const live = await repo.claimForResume(run.runId, SECOND_ASKING);
        expect(live?.status).toBe('running');
    });

    it('leaves an unanswered question by its timeout handle, and disables its controls', async () => {
        // The other half of the lifecycle: the claim refuses a stale press, and
        // this stops most members ever making one. Driven through `resumeFlowRun`
        // rather than against the helper, because what is in doubt is whether the
        // resume path calls it at all — a helper tested alone would pass with
        // nothing wired to it.
        const edit = vi.fn().mockResolvedValue(undefined);
        // A real button row, the shape `channel.send` leaves on a posted question.
        // An empty `components` would drive the release without ever running the
        // rebuild inside it, so the assertion below would prove only that an edit
        // happened — not that it disabled anything.
        const fetch = vi.fn().mockResolvedValue({
            components: [
                {
                    type: ComponentType.ActionRow,
                    components: [
                        { type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: 'flowc:a:b:0', label: 'Yes' },
                        { type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: 'flowc:a:b:1', label: 'No' },
                    ],
                },
            ],
            edit,
        });
        const { client, userSend } = makeClient({ id: CHANNEL_ID, messages: { fetch } });

        const run = await parkOnQuestion(FIRST_ASKING);

        const outcome = await resumeFlowRun(client, run, RESUME_TIMEOUT, {
            flowsRepo: { getByFlowId: vi.fn().mockResolvedValue(questionFlow()) },
            flowRunsRepo: repo,
        });

        // The timeout branch, which is the third of this slice's three items: an
        // unanswered question leaves by its own handle instead of parking forever.
        expect(outcome.status).toBe('completed');
        expect(sentCopy(userSend)).toContain('You left it too long.');

        // And the message the park named is fetched and edited — once — so the
        // buttons of a question nobody answered do not stay live.
        expect(fetch).toHaveBeenCalledWith(FIRST_ASKING);
        expect(edit).toHaveBeenCalledTimes(1);

        // Every button comes back disabled, and keeps its id: a disabled control
        // that kept its id still parses if a stale client replays it, and is then
        // refused by the claim for the true reason.
        const rebuilt = (edit.mock.calls[0]?.[0] as { components: { toJSON(): unknown }[] }).components;
        const row = rebuilt[0]?.toJSON() as {
            components: { disabled?: boolean; custom_id?: string; label?: string }[];
        };
        expect(row.components.map((button) => button.disabled)).toEqual([true, true]);
        expect(row.components.map((button) => button.custom_id)).toEqual(['flowc:a:b:0', 'flowc:a:b:1']);
        expect(row.components.map((button) => button.label)).toEqual(['Yes', 'No']);
    });

    it('still disables the controls when the terminal write is rejected', async () => {
        // The path the lifecycle names: an operator cancels a `running` run, so the
        // resumer's own terminal write is refused and `mustTransition` throws. The
        // run is over either way — returning the buttons to the channel still live
        // would be the one outcome this slice exists to prevent.
        const edit = vi.fn().mockResolvedValue(undefined);
        const fetch = vi.fn().mockResolvedValue({ components: [], edit });
        const { client } = makeClient({ id: CHANNEL_ID, messages: { fetch } });

        const run = await parkOnQuestion(FIRST_ASKING);
        const rejecting = {
            ...repo,
            claimForResume: repo.claimForResume.bind(repo),
            releaseClaim: repo.releaseClaim.bind(repo),
            park: repo.park.bind(repo),
            fail: repo.fail.bind(repo),
            complete: vi.fn().mockRejectedValue(new Error('the row changed underneath the write')),
        };

        await expect(
            resumeFlowRun(client, run, RESUME_TIMEOUT, {
                flowsRepo: { getByFlowId: vi.fn().mockResolvedValue(questionFlow()) },
                flowRunsRepo: rejecting,
            })
        ).rejects.toThrow('the row changed underneath the write');

        // The throw still propagates — it is not swallowed — and the buttons are
        // down regardless.
        expect(edit).toHaveBeenCalledTimes(1);
    });

    it('disables the controls of a question whose flow was deleted underneath it', async () => {
        // The commonest way a real question ends badly, and the one a `finally`
        // around the segment does not reach: the run fails before a segment ever
        // runs, so an early return would skip the tidy-up entirely and leave the
        // buttons live in the channel forever.
        const edit = vi.fn().mockResolvedValue(undefined);
        const fetch = vi.fn().mockResolvedValue({ components: [], edit });
        const { client } = makeClient({ id: CHANNEL_ID, messages: { fetch } });

        const run = await parkOnQuestion(FIRST_ASKING);

        const outcome = await resumeFlowRun(client, run, RESUME_TIMEOUT, {
            flowsRepo: { getByFlowId: vi.fn().mockResolvedValue(null) },
            flowRunsRepo: repo,
        });

        expect(outcome.status).toBe('failed');
        expect(edit).toHaveBeenCalledTimes(1);
    });

    it('refuses a press once the run has finished, and clears what it was waiting on', async () => {
        const run = await parkOnQuestion(FIRST_ASKING);

        await repo.claimForResume(run.runId);
        await repo.complete(run.runId);

        // A terminal transition drops the message with the rest of the resume
        // fields, so a press naming it matches nothing — the run is not merely
        // unclaimable, it is no longer waiting on anybody's button.
        expect((await repo.getByRunId(run.runId))?.waitMessageId).toBeNull();
        expect(await repo.claimForResume(run.runId, FIRST_ASKING)).toBeNull();
    });
});
