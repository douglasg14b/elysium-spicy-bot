import type { ButtonInteraction, Client } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION_PROMPT, PROMPT_TIMEOUT_HANDLE } from '../blocks/actionPrompt';
import { ensureBlocksDiscovered } from '../blocks/registry';
import { RESUME_TIMEOUT } from '../blocks/types';
import { flowGraphSchema, type FlowNode } from '../data/flowGraph';
import { FlowRunsRepo } from '../data/flowRunsRepo';
import type { FlowRunEntity } from '../data/flowRunsSchema';
import type { FlowEntity } from '../data/flowsSchema';
import { ELIGIBILITY_CONFIG_KEY, UNREADABLE_GATE_MESSAGE } from '../engine/eligibility';
import { handleFlowChoiceInteraction } from '../engine/flowChoiceDispatch';
import { failParkedRun, resumeFlowRun } from '../engine/flowRunResume';
import { resetFlowRunSchedulerForTests } from '../engine/flowRunScheduler';
import { flowReadinessIssues } from '../logic/flowReadiness';
import { buildFlowChoiceCustomId } from '../utils/customId';
import {
    createFlowRunsTestDb,
    type FlowRunsTestDb,
} from '../../../features-system/data-persistence/__tests__/support/flowRunsTestDb';

/**
 * A parked run waking into a graph that was saved incomplete underneath it.
 *
 * Reachable now that a switched-off flow can hold an incomplete graph: a run parked on
 * a question keeps its row while the operator switches the flow off and saves a
 * half-finished edit, and the resume path — the scheduler for a timeout, a press for a
 * choice — walks whatever graph is stored. It does not ask whether the flow is enabled,
 * and it is not meant to: a run already in progress is finished or failed, never
 * stranded, so switching a flow off does not abandon the members mid-way through it.
 *
 * What must hold is that it **fails cleanly**: the run ends `failed` with a reason an
 * operator can read, the question's buttons come down, and nothing is sent. The guard
 * is the executor's own re-parse of each node's config before running it, which is
 * why these go through `resumeFlowRun` rather than the executor alone — a guard tested
 * on its own proves nothing about whether the path that matters reaches it.
 */

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';
const CHANNEL_ID = 'channel-1';
const QUESTION_NODE = 'question';
const AFTER_TIMEOUT = 'after-timeout';
const WAIT_MESSAGE = 'message-question';

beforeAll(ensureBlocksDiscovered);

/** A client whose guild resolves the member and the channel the question was posted in. */
function makeClient(): {
    client: Client;
    userSend: ReturnType<typeof vi.fn>;
    edit: ReturnType<typeof vi.fn>;
} {
    const userSend = vi.fn().mockResolvedValue(undefined);
    const edit = vi.fn().mockResolvedValue(undefined);
    const member = {
        id: USER_ID,
        user: { id: USER_ID, send: userSend },
        roles: { cache: { has: () => false } },
    };
    const channel = {
        id: CHANNEL_ID,
        isDMBased: () => false,
        isTextBased: () => true,
        messages: { fetch: vi.fn().mockResolvedValue({ components: [], edit }) },
    };
    const guild = {
        id: GUILD_ID,
        members: { fetch: vi.fn().mockResolvedValue(member) },
        channels: { cache: { get: (id: string) => (id === CHANNEL_ID ? channel : undefined) } },
    };

    return {
        client: {
            user: { id: 'bot-1' },
            guilds: { cache: { get: () => guild }, fetch: vi.fn().mockResolvedValue(guild) },
        } as unknown as Client,
        userSend,
        edit,
    };
}

/**
 * The flow as the operator left it: **switched off**, with the given nodes. The question
 * leaves by its timeout handle to `AFTER_TIMEOUT` whenever both are present.
 */
function switchedOffFlow(nodes: readonly FlowNode[]): FlowEntity {
    const ids = new Set(nodes.map((node) => node.id));
    return {
        flowId: 'question-flow',
        guildId: GUILD_ID,
        enabled: false,
        graph: flowGraphSchema.parse({
            version: 1,
            nodes,
            edges:
                ids.has(QUESTION_NODE) && ids.has(AFTER_TIMEOUT)
                    ? [
                          {
                              id: 'edge-question-timeout',
                              source: QUESTION_NODE,
                              sourceHandle: PROMPT_TIMEOUT_HANDLE,
                              target: AFTER_TIMEOUT,
                          },
                      ]
                    : [],
        }),
    } as FlowEntity;
}

const question = (data: Record<string, unknown>): FlowNode => ({
    id: QUESTION_NODE,
    type: ACTION_PROMPT,
    position: { x: 0, y: 0 },
    data,
});

const dmAfterTimeout = (data: Record<string, unknown>): FlowNode => ({
    id: AFTER_TIMEOUT,
    type: 'action.sendDM',
    position: { x: 220, y: 0 },
    data,
});

describe('a parked run resuming into an incomplete graph', () => {
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

    const parkOnQuestion = async (): Promise<FlowRunEntity> =>
        repo.create({
            flowId: 'question-flow',
            guildId: GUILD_ID,
            contextSnapshot: { guildId: GUILD_ID, userId: USER_ID, channelId: CHANNEL_ID },
            resumeNodeId: QUESTION_NODE,
            waitMessageId: WAIT_MESSAGE,
        });

    /** Resume by the timeout, as the scheduler would, and read back what was recorded. */
    const resumeInto = async (flow: FlowEntity) => {
        const { client, userSend, edit } = makeClient();
        const run = await parkOnQuestion();
        const outcome = await resumeFlowRun(client, run, RESUME_TIMEOUT, {
            flowsRepo: { getByFlowId: vi.fn().mockResolvedValue(flow) },
            flowRunsRepo: repo,
        });
        return { outcome, stored: await repo.getByRunId(run.runId), userSend, edit };
    };

    it('fails the run, naming the node whose config is missing, when the next step is incomplete', async () => {
        const flow = switchedOffFlow([
            question({ question: 'Well?', choices: ['Yes', 'No'] }),
            // Emptied by the operator, and saved while the flow was off.
            dmAfterTimeout({ message: '' }),
        ]);
        // The premise, asserted rather than assumed: this graph is one the enable
        // gate would refuse, so it is the state the new save path can produce.
        expect(flowReadinessIssues(flow.graph, new Set()).map((issue) => issue.nodeId)).toEqual([AFTER_TIMEOUT]);

        const { outcome, stored, userSend, edit } = await resumeInto(flow);

        expect(outcome.status).toBe('failed');
        expect(stored?.status).toBe('failed');
        expect(stored?.error).toMatch(/Invalid config for action\.sendDM/);
        // The log says where: the step that refused, after the question that woke.
        expect(stored?.log.at(-1)).toMatchObject({ nodeId: AFTER_TIMEOUT, status: 'error' });
        // Nothing half-sent, and the question's buttons are taken down with the run.
        expect(userSend).not.toHaveBeenCalled();
        expect(edit).toHaveBeenCalledTimes(1);
    });

    it('fails the run when the question it parked on has itself been left incomplete', async () => {
        const flow = switchedOffFlow([
            question({ question: 'Well?', choices: [] }),
            dmAfterTimeout({ message: 'You left it too long.' }),
        ]);

        const { outcome, stored, userSend, edit } = await resumeInto(flow);

        expect(outcome.status).toBe('failed');
        expect(stored?.status).toBe('failed');
        expect(stored?.error).toMatch(/Invalid config for action\.prompt/);
        expect(userSend).not.toHaveBeenCalled();
        expect(edit).toHaveBeenCalledTimes(1);
    });

    it('fails the run when the question it parked on was deleted from the graph', async () => {
        const flow = switchedOffFlow([dmAfterTimeout({ message: 'You left it too long.' })]);

        const { outcome, stored, userSend, edit } = await resumeInto(flow);

        expect(outcome.status).toBe('failed');
        expect(stored?.error).toMatch(new RegExp(`Resume node ${QUESTION_NODE} not found`));
        expect(userSend).not.toHaveBeenCalled();
        expect(edit).toHaveBeenCalledTimes(1);
    });

    it('fails the run when the question’s own gate is unreadable, and still refuses the press', async () => {
        // A roles gate picked before its roles: the shape an off flow may now store. A
        // press can never pass it, and this question has no timeout — so left parked, the
        // run would wait for a fix nobody knows is needed.
        const flow = switchedOffFlow([
            question({
                question: 'Well?',
                choices: ['Yes', 'No'],
                [ELIGIBILITY_CONFIG_KEY]: { principal: 'roles', roleIds: [] },
            }),
        ]);
        const { client, userSend, edit } = makeClient();
        const run = await parkOnQuestion();
        const resume = vi.fn();
        const followUp = vi.fn().mockResolvedValue(undefined);
        const interaction = {
            customId: buildFlowChoiceCustomId(run.runId, QUESTION_NODE, 0),
            deferred: true,
            replied: false,
            guild: { id: GUILD_ID },
            user: { id: USER_ID },
            message: { id: WAIT_MESSAGE },
            client,
            followUp,
        } as unknown as ButtonInteraction;

        const result = await handleFlowChoiceInteraction(interaction, {
            flowRunsRepo: repo,
            flowsRepo: { getByFlowId: vi.fn().mockResolvedValue(flow) },
            resume: resume as never,
            failParked: (failClient, failRun, reason, park) =>
                failParkedRun(failClient, failRun, reason, park, { flowRunsRepo: repo }),
        });

        // The security half first: the press was refused, and the question never ran.
        expect(result.status).toBe('error');
        expect(followUp).toHaveBeenCalledWith({ content: `❌ ${UNREADABLE_GATE_MESSAGE}`, ephemeral: true });
        expect(resume).not.toHaveBeenCalled();
        expect(userSend).not.toHaveBeenCalled();

        // And the run is over, saying why, with the question's buttons taken down.
        const stored = await repo.getByRunId(run.runId);
        expect(stored?.status).toBe('failed');
        expect(stored?.error).toMatch(new RegExp(`node ${QUESTION_NODE} has an eligibility rule`));
        expect(edit).toHaveBeenCalledTimes(1);
    });
});
