import type { Client } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketChange, TicketChangeEvent, TicketEntity } from '../../tickets';
import {
    createFlowRunsTestDb,
    type FlowRunsTestDb,
} from '../../../features-system/data-persistence/__tests__/support/flowRunsTestDb';
import { ensureBlocksDiscovered } from '../blocks/registry';
import { RESUME_TIMEOUT, type FlowRunSeed } from '../blocks/types';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../data/flowGraph';
import { FlowRunsRepo, flowRunsRepo } from '../data/flowRunsRepo';
import type { FlowEntity } from '../data/flowsSchema';
import { executeFlow } from '../engine/executor';
import { resumeFlowRun } from '../engine/flowRunResume';
import type { TriggeredRun } from '../engine/triggeredRun';

/**
 * A run keeps its place in a chain of runs across a park.
 *
 * Driven through production's own write path (the executor's default `onSuspend`) and
 * the real resume path, then through the real Close Ticket block and the real Ticket
 * Event dispatcher: a run started three deep parks, wakes, closes a ticket, and the run
 * that close starts is four deep. The ticket service and the run start are mocked — the
 * ticket's own write is the service's test, and the started run is the executor's.
 */

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';
const TICKET_ID = 12;

const closeTicket = vi.fn();
const getTicket = vi.fn();
const getByGuildId = vi.fn();
const startTriggeredRun = vi.fn();

vi.mock('../../tickets', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../tickets')>()),
    closeTicket: (...args: unknown[]) => closeTicket(...args),
    getTicket: (...args: unknown[]) => getTicket(...args),
}));
// No usable config, so Close Ticket takes its direct close — the path with no Discord.
vi.mock('../../tickets/data/ticketingRepo', () => ({ ticketingRepo: { get: vi.fn().mockResolvedValue(null) } }));
vi.mock('../data/flowsRepo', () => ({ flowsRepo: { getByGuildId: (...args: unknown[]) => getByGuildId(...args) } }));
vi.mock('../engine/triggeredRun', () => ({ startTriggeredRun: (...args: unknown[]) => startTriggeredRun(...args) }));

const { handleTicketChange } = await import('../logic/ticketEventDispatch');

beforeAll(ensureBlocksDiscovered);

/** join -> delay -> close the ticket in the bag. */
const graph: FlowGraph = {
    version: FLOW_GRAPH_VERSION,
    nodes: [
        { id: 'trigger', type: 'trigger.memberJoin', position: { x: 0, y: 0 }, data: {} },
        { id: 'delay', type: 'action.delay', position: { x: 1, y: 0 }, data: { durationMs: 60_000 } },
        { id: 'close', type: 'action.closeTicket', position: { x: 2, y: 0 }, data: { ticketId: '{{var.ticketId}}' } },
    ],
    edges: [
        { id: 'e1', source: 'trigger', target: 'delay' },
        { id: 'e2', source: 'delay', target: 'close' },
    ],
} as FlowGraph;

const flow = { flowId: 'flow-1', guildId: GUILD_ID, graph, enabled: true } as FlowEntity;

/** A follow-on flow listening for the close. */
const followOnGraph: FlowGraph = {
    version: FLOW_GRAPH_VERSION,
    nodes: [{ id: 'closed', type: 'trigger.ticketEvent', position: { x: 0, y: 0 }, data: { event: 'closed' } }],
    edges: [],
};
const followOn = { flowId: 'flow-2', guildId: GUILD_ID, graph: followOnGraph, enabled: true } as FlowEntity;

const ticket = { id: TICKET_ID, guildId: GUILD_ID, ticketNumber: 34, type: 'aftercare', status: 'open', subjectId: USER_ID, channelId: null } as TicketEntity;

function seed(chainDepth?: number): FlowRunSeed {
    return {
        client: {} as FlowRunSeed['client'],
        guild: { id: GUILD_ID } as FlowRunSeed['guild'],
        subject: { id: USER_ID } as FlowRunSeed['subject'],
        variables: { ticketId: TICKET_ID },
        ...(chainDepth === undefined ? {} : { chainDepth }),
    };
}

/** A client that can re-fetch the guild and member a resumed run needs, and the dispatcher after it. */
function resumeClient(): Client {
    const member = { id: USER_ID };
    const guild = {
        id: GUILD_ID,
        client: { user: { id: 'bot-1' } },
        members: { fetch: vi.fn().mockResolvedValue(member) },
        channels: { fetch: vi.fn().mockResolvedValue(null) },
    };
    return {
        user: { id: 'bot-1' },
        guilds: { cache: { get: () => guild }, fetch: vi.fn().mockResolvedValue(guild) },
    } as unknown as Client;
}

describe('a run’s place in a chain of runs', () => {
    let testDb: FlowRunsTestDb;
    let repo: FlowRunsRepo;

    beforeEach(async () => {
        vi.clearAllMocks();
        testDb = await createFlowRunsTestDb();
        repo = new FlowRunsRepo(testDb.db);
        vi.spyOn(flowRunsRepo, 'create').mockImplementation((input) => repo.create(input));
        getTicket.mockResolvedValue(ticket);
        closeTicket.mockResolvedValue({ ok: true, value: { ...ticket, status: 'closed' } });
        getByGuildId.mockResolvedValue([followOn]);
        startTriggeredRun.mockResolvedValue(undefined);
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

    it('parks at depth 3, closes a ticket after waking, and the run that close starts is depth 4', async () => {
        await executeFlow('flow-1', graph, 'trigger', seed(3));

        const [parked] = await testDb.db.selectFrom('flow_runs').select('runId').execute();
        if (!parked) throw new Error('the run did not park');
        expect((await repo.getByRunId(parked.runId))?.contextSnapshot.chainDepth).toBe(3);

        expect((await resume(parked.runId)).status).toBe('completed');

        // Close Ticket reported the run's own depth, and nobody as the actor.
        expect(closeTicket).toHaveBeenCalledWith(TICKET_ID, { actorId: null, chainDepth: 3 });

        // The announcement the service makes from that change starts the follow-on one deeper.
        const handed = closeTicket.mock.calls[0]?.[1] as TicketChange;
        const announced: TicketChangeEvent = { kind: 'closed', ticket, changedAt: new Date(), ...handed };
        await handleTicketChange(resumeClient(), announced);
        expect(startTriggeredRun.mock.calls.map((call) => (call[0] as TriggeredRun).seed.chainDepth)).toEqual([4]);
    });

    it('starts at depth 1 when its trigger carries none, and records that', async () => {
        await executeFlow('flow-1', graph, 'trigger', seed());

        const [parked] = await testDb.db.selectFrom('flow_runs').select('runId').execute();
        if (!parked) throw new Error('the run did not park');
        expect((await repo.getByRunId(parked.runId))?.contextSnapshot.chainDepth).toBe(1);
    });

    it('reads as depth 1 when it parked before depth was recorded', async () => {
        const row = await repo.create({
            flowId: 'flow-1',
            guildId: GUILD_ID,
            contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
            resumeNodeId: 'delay',
            wakeAt: new Date(Date.now() - 1000),
            visitsUsed: 2,
            variables: { ticketId: TICKET_ID },
        });

        expect((await resume(row.runId)).status).toBe('completed');

        expect(closeTicket).toHaveBeenCalledWith(TICKET_ID, { actorId: null, chainDepth: 1 });
    });
});
