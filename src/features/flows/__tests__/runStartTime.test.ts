import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlockManifest } from '../blocks/manifest';
import { ensureBlocksDiscovered, getBlockDefinition } from '../blocks/registry';
import { RESUME_TIMEOUT, type FlowRunContext, type FlowRunSeed } from '../blocks/types';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../data/flowGraph';
import { FlowRunsRepo, flowRunsRepo } from '../data/flowRunsRepo';
import type { FlowEntity } from '../data/flowsSchema';
import {
    createFlowRunsTestDb,
    type FlowRunsTestDb,
} from '../../../features-system/data-persistence/__tests__/support/flowRunsTestDb';
import { executeFlow } from '../engine/executor';
import { resumeFlowRun } from '../engine/flowRunResume';
import { FIXTURE_RECORD_START } from './fixtures/blocks/contract/actionRecordStart';

/**
 * A run knows when it started, on its first leg and after every park.
 *
 * Driven through production's own write path — the executor's default `onSuspend` —
 * and the real resume path, because the property lives in the seam between them: the
 * first park writes the instant into the snapshot, a later park must leave it alone,
 * and the resume must hand it back rather than the row's `createdAt`.
 */

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';
const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'blocks', 'contract');

vi.mock('../blocks/registry', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../blocks/registry')>();
    let extra: ReadonlyMap<string, BlockManifest> | undefined;

    return {
        ...actual,
        ensureBlocksDiscovered: async () => {
            await actual.ensureBlocksDiscovered();
            extra ??= await actual.discoverBlocks<BlockManifest>(FIXTURE_ROOT);
        },
        getBlockDefinition: (type: string) => extra?.get(type) ?? actual.getBlockDefinition(type),
    };
});

beforeAll(ensureBlocksDiscovered);

/** record -> delay -> record, so the start time is read on both legs. */
const graph: FlowGraph = {
    version: FLOW_GRAPH_VERSION,
    nodes: [
        { id: 'trigger', type: 'trigger.memberJoin', position: { x: 0, y: 0 }, data: {} },
        { id: 'before', type: FIXTURE_RECORD_START, position: { x: 1, y: 0 }, data: {} },
        { id: 'delay', type: 'action.delay', position: { x: 2, y: 0 }, data: { durationMs: 60_000 } },
        { id: 'after', type: FIXTURE_RECORD_START, position: { x: 3, y: 0 }, data: {} },
    ],
    edges: [
        { id: 'e1', source: 'trigger', target: 'before' },
        { id: 'e2', source: 'before', target: 'delay' },
        { id: 'e3', source: 'delay', target: 'after' },
    ],
} as FlowGraph;

const flow = { flowId: 'flow-1', guildId: GUILD_ID, graph, enabled: true } as FlowEntity;

function seed(): FlowRunSeed {
    return {
        client: {} as FlowRunSeed['client'],
        guild: { id: GUILD_ID } as FlowRunSeed['guild'],
        subject: { id: USER_ID } as FlowRunSeed['subject'],
        variables: {},
    };
}

/** A client that can re-fetch the guild and member a resumed run needs. */
function resumeClient(): Client {
    const guild = { id: GUILD_ID, members: { fetch: vi.fn().mockResolvedValue({ id: USER_ID }) } };
    return {
        user: { id: 'bot-1' },
        guilds: { cache: { get: () => guild }, fetch: vi.fn().mockResolvedValue(guild) },
    } as unknown as Client;
}

describe('the time a run started', () => {
    let testDb: FlowRunsTestDb;
    let repo: FlowRunsRepo;
    /** The `startedAt` each visit to the recording block was handed, in order. */
    let seen: (Date | undefined)[];

    beforeEach(async () => {
        testDb = await createFlowRunsTestDb();
        repo = new FlowRunsRepo(testDb.db);
        seen = [];

        const recorder = getBlockDefinition(FIXTURE_RECORD_START);
        if (!recorder) throw new Error('the fixture block was not discovered');
        const original = recorder.run.bind(recorder);
        vi.spyOn(recorder, 'run').mockImplementation((config, context: FlowRunContext) => {
            seen.push(context.startedAt);
            return original(config, context);
        });
        // Production's default `onSuspend`, pointed at the test database.
        vi.spyOn(flowRunsRepo, 'create').mockImplementation((input) => repo.create(input));
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await testDb.db.destroy();
    });

    const resume = async (runId: string) => {
        const row = await repo.getByRunId(runId);
        if (!row) throw new Error('the parked run disappeared');
        return resumeFlowRun(resumeClient(), row, RESUME_TIMEOUT, {
            flowsRepo: { getByFlowId: vi.fn().mockResolvedValue(flow) },
            flowRunsRepo: repo,
        });
    };

    it('is the same instant on the first leg, in the row, after a second park and on resume', async () => {
        await executeFlow('flow-1', graph, 'trigger', seed());

        const [started] = seen;
        if (!started) throw new Error('the first leg was handed no start time');
        const [parked] = await testDb.db.selectFrom('flow_runs').select('runId').execute();
        if (!parked) throw new Error('the run did not park');
        expect((await repo.getByRunId(parked.runId))?.contextSnapshot.startedAt).toBe(started.toISOString());

        // A second park goes through `park`, which must leave the snapshot alone.
        const before = await repo.getByRunId(parked.runId);
        if (!before?.resumeNodeId) throw new Error('the parked run has nowhere to resume');
        await repo.claimForResume(parked.runId);
        await repo.park(parked.runId, {
            resumeNodeId: before.resumeNodeId,
            wakeAt: new Date(Date.now() - 1000),
            visitsUsed: before.visitsUsed,
            log: before.log,
            variables: before.variables,
        });
        expect((await repo.getByRunId(parked.runId))?.contextSnapshot.startedAt).toBe(started.toISOString());

        const outcome = await resume(parked.runId);

        expect(outcome.status).toBe('completed');
        expect(seen.map((instant) => instant?.toISOString())).toEqual([started.toISOString(), started.toISOString()]);
    });

    it('is absent, not the row’s creation time, on a run parked before it was recorded', async () => {
        const row = await repo.create({
            flowId: 'flow-1',
            guildId: GUILD_ID,
            contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
            resumeNodeId: 'delay',
            wakeAt: new Date(Date.now() - 1000),
            visitsUsed: 2,
        });

        const outcome = await resume(row.runId);

        expect(outcome.status).toBe('completed');
        expect(seen).toEqual([undefined]);
    });
});
