import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../../features/flows/data/flowGraph';
import { ensureBlocksDiscovered } from '../../../features/flows/blocks/registry';
import type { FlowValidationIssue } from '../../../features/flows/engine/nodeDataValidation';
import type { FlowValidationIssue as BrowserFlowValidationIssue } from '../../../../web/src/api/types';
import type { AppEnv } from '../../types';

/**
 * The browser's mirror of the issue shape, held to the server's.
 *
 * `web/src/api/types.ts` is hand-written — its own header explains why, and says
 * "the drift test is the price of making it". This is that price for this type.
 * Assignability is checked in **both** directions: one alone silently permits the
 * other side to grow a member, and a browser reading a key the server never sends
 * is exactly as broken as the reverse.
 *
 * A compile-time check rather than a runtime one, so it fails in `pnpm build`
 * rather than waiting for this file to be run.
 */
const serverIssueFitsBrowser: BrowserFlowValidationIssue = {} as FlowValidationIssue;
const browserIssueFitsServer: FlowValidationIssue = {} as BrowserFlowValidationIssue;
void serverIssueFitsBrowser;
void browserIssueFitsServer;

/**
 * What the save endpoint refuses, and how it says so.
 *
 * `flowRoutes()` is a bare Hono app — auth and guild resolution are applied where it
 * is mounted — so these inject a guild and focus on the two things the route decides:
 * which graphs are allowed to save, and what a rejection looks like on the wire.
 *
 * Both repos are mocked. Storage is settled elsewhere; what is under test here is
 * that the route consults the flow's declarations before judging its picker fields,
 * and that a rejection carries placement rather than one flattened sentence.
 */

const flowsRepoMock = {
    getByFlowId: vi.fn(),
    getByGuildId: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deleteByFlowId: vi.fn(),
};

const journeysRepoMock = {
    getByKey: vi.fn(),
};

vi.mock('../../../features/flows/data/flowsRepo', () => ({ flowsRepo: flowsRepoMock }));
vi.mock('../../../features/provisioning/data/journeysRepo', () => ({
    journeysRepo: journeysRepoMock,
}));

const { flowRoutes } = await import('../flowRoutes');

// The validators read the block registry.
await ensureBlocksDiscovered();

const GUILD_ID = 'guild-1';
const FLOW_ID = 'flow-1';

function app() {
    const outer = new Hono<AppEnv>();
    outer.use('*', async (c, next) => {
        c.set('guild', { id: GUILD_ID } as never);
        await next();
    });
    outer.route('/', flowRoutes());
    return outer;
}

function put(graph: FlowGraph) {
    return app().request(`/${GUILD_ID}/flows/${FLOW_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ graph }),
    });
}

/** A one-node graph whose channel is empty and whose sidecar names `key`. */
function graphPicking(key: string | undefined): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            {
                id: 'send',
                type: 'action.sendMessage',
                position: { x: 0, y: 0 },
                data: {
                    channelId: '',
                    message: 'Hi',
                    ...(key === undefined ? {} : { channelIdKey: key }),
                },
            },
        ],
        edges: [],
    };
}

interface RejectionBody {
    error: string;
    issues: { nodeId?: string; field?: string; message: string }[];
}

beforeEach(() => {
    vi.clearAllMocks();
    flowsRepoMock.getByFlowId.mockResolvedValue({
        flowId: FLOW_ID,
        guildId: GUILD_ID,
        name: 'Test',
        enabled: false,
        graph: { version: FLOW_GRAPH_VERSION, nodes: [], edges: [] },
        createdAt: new Date('2026-09-19T10:00:00Z'),
        updatedAt: new Date('2026-09-19T10:00:00Z'),
    });
    flowsRepoMock.update.mockImplementation(async (flowId: string, patch: { graph?: FlowGraph }) => ({
        flowId,
        guildId: GUILD_ID,
        name: 'Test',
        enabled: false,
        graph: patch.graph ?? { version: FLOW_GRAPH_VERSION, nodes: [], edges: [] },
        createdAt: new Date('2026-09-19T10:00:00Z'),
        updatedAt: new Date('2026-09-19T10:00:00Z'),
    }));
    journeysRepoMock.getByKey.mockResolvedValue(null);
});

describe('saving a graph that picked a declared resource', () => {
    it('accepts an empty picker field whose sidecar names a declared resource', async () => {
        journeysRepoMock.getByKey.mockResolvedValue({
            journeyKey: FLOW_ID,
            resources: [{ key: 'qa-channel', kind: 'textChannel', defaultName: 'questions' }],
        });

        const response = await put(graphPicking('qa-channel'));

        expect(response.status).toBe(200);
        expect(flowsRepoMock.update).toHaveBeenCalled();
        // Keyed on the flow's own id: a flow's journey is implicit.
        expect(journeysRepoMock.getByKey).toHaveBeenCalledWith(GUILD_ID, FLOW_ID);
    });

    it('refuses the same graph when the flow declares nothing', async () => {
        const response = await put(graphPicking('qa-channel'));

        expect(response.status).toBe(400);
        const body = (await response.json()) as RejectionBody;
        expect(body.issues).toHaveLength(1);
        expect(body.issues[0]?.message).toContain('qa-channel');
        expect(flowsRepoMock.update).not.toHaveBeenCalled();
    });

    it('still refuses an empty picker field with no sidecar at all', async () => {
        journeysRepoMock.getByKey.mockResolvedValue({
            journeyKey: FLOW_ID,
            resources: [{ key: 'qa-channel', kind: 'textChannel', defaultName: 'questions' }],
        });

        const response = await put(graphPicking(undefined));

        expect(response.status).toBe(400);
        expect(flowsRepoMock.update).not.toHaveBeenCalled();
    });

    it('names the cause when the declarations cannot be read', async () => {
        // `journeysRepo` validates on read and throws on a malformed row. Left to
        // fall through, that is a bare 500 and the author is told to try again in a
        // second, forever, on a graph that is fine.
        journeysRepoMock.getByKey.mockRejectedValue(
            new Error('Journey flow-1 has a stored resources column that is not an array.')
        );

        const response = await put(graphPicking('qa-channel'));

        expect(response.status).toBe(500);
        const body = (await response.json()) as { error: string };
        expect(body.error).toContain('not an array');
        // Not recovered from by treating the flow as declaring nothing, which would
        // blame the author's graph for a data problem they cannot see.
        expect(flowsRepoMock.update).not.toHaveBeenCalled();
    });

    it('declares nothing for a flow that does not exist yet', async () => {
        // POST validates a graph for a flow with no id, so there is no journey to
        // read. Nothing is declared, so a sidecar there names something undeclared.
        const response = await app().request(`/${GUILD_ID}/flows`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'New', graph: graphPicking('qa-channel') }),
        });

        expect(response.status).toBe(400);
        expect(journeysRepoMock.getByKey).not.toHaveBeenCalled();
        expect(flowsRepoMock.create).not.toHaveBeenCalled();
    });
});

describe('what a rejected save puts on the wire', () => {
    it('carries issues addressed to the node and field, and the legacy error string', async () => {
        const graph: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                {
                    id: 'send',
                    type: 'action.sendMessage',
                    position: { x: 0, y: 0 },
                    data: { channelId: '', message: 'Hi' },
                },
            ],
            edges: [],
        };

        const response = await put(graph);

        expect(response.status).toBe(400);
        const body = (await response.json()) as RejectionBody;

        expect(body.issues[0]?.nodeId).toBe('send');
        expect(body.issues[0]?.field).toBe('channelId');
        // `error` is what every existing client reads and `ApiError` falls back to.
        // Dropping it would break them for no gain, so it is asserted, not assumed.
        expect(body.error).toContain('send');
        expect(body.error).toContain('channelId');
    });

    it('reports an unknown block type as a node-level issue with no field', async () => {
        const graph: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [{ id: 'mystery', type: 'action.nope', position: { x: 0, y: 0 }, data: {} }],
            edges: [],
        };

        const response = await put(graph);
        const body = (await response.json()) as RejectionBody;

        expect(body.issues[0]?.nodeId).toBe('mystery');
        expect(body.issues[0]?.field).toBeUndefined();
    });

    it('reports a whole-graph problem with no node to blame', async () => {
        const graph: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [],
            edges: [{ id: 'dangling', source: 'nowhere', target: 'nothing' }],
        };

        const response = await put(graph);
        const body = (await response.json()) as RejectionBody;

        expect(body.issues[0]?.nodeId).toBeUndefined();
        expect(body.error).not.toBe('');
    });
});
