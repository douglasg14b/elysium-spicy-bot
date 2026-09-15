import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_MAX_VARIABLES_SIZE } from '../constants';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../data/flowGraph';
import { FlowRunsRepo } from '../data/flowRunsRepo';
import type { FlowEntity } from '../data/flowsSchema';
import {
    createFlowRunsTestDb,
    type FlowRunsTestDb,
} from '../../../features-system/data-persistence/__tests__/support/flowRunsTestDb';
import { discoverBlocks, ensureBlocksDiscovered, getBlockDefinition } from '../blocks/registry';
import type { BlockManifest } from '../blocks/manifest';
import { RESUME_TIMEOUT, type FlowRunSeed } from '../blocks/types';
import { executeFlow, executeFlowSegment } from '../engine/executor';
import { rebuildResumeContext, resumeFlowRun } from '../engine/flowRunResume';
import { validateAuthoredGraph } from '../engine/graphValidation';
import { ACTION_RECORD_VALUE } from './fixtures/blocks/producer/actionRecordValue';
import { sentCopy } from './support/sentCopy';

/**
 * Step 2's bar, end to end: *a block can consume a value another block produced,
 * and copy can address the subject.*
 *
 * Everything here drives the real executor over real blocks. The producer is a
 * fixture block, but it is discovered, validated and run exactly like a product
 * block — a hand-built stub would only prove that a callback gets called.
 *
 * It stays a fixture now that `action.pickRandom` ships as a real producer,
 * because the two prove different things: this file needs a producer whose value
 * it *chooses*, to assert what the bag does with a specific key, a specific size
 * and a specific resume. A block that records something random by design can pin
 * none of those. The shipped block's own producer→consumer path is proven in
 * `pickRandom.test.ts`.
 */

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';
const SUBJECT_MENTION = `<@${USER_ID}>`;

const FIXTURE_ROOT = join(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'blocks',
    'producer'
);

/**
 * The real registry plus the producer fixture.
 *
 * Mocked rather than dropped into the product tree because the producer is not a
 * block anybody should be offered in a palette — and the discovery suite pins the
 * shipped list exactly, which is a gate worth keeping rather than loosening.
 */
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

function makeSeed(): { context: FlowRunSeed; userSend: ReturnType<typeof vi.fn> } {
    const userSend = vi.fn().mockResolvedValue(undefined);
    const subject = {
        id: USER_ID,
        toString: () => SUBJECT_MENTION,
        user: { id: USER_ID, username: 'spicypete', send: userSend },
        roles: { add: vi.fn(), cache: { has: () => false } },
    } as unknown as FlowRunSeed['subject'];

    return {
        context: {
            client: {} as FlowRunSeed['client'],
            guild: { id: GUILD_ID, name: 'Afterdark' } as FlowRunSeed['guild'],
            subject,
            variables: {},
        },
        userSend,
    };
}

/** A client that can re-fetch the guild and member a resumed run needs. */
function makeResumeClient(): { client: Client; resumeSend: ReturnType<typeof vi.fn> } {
    const resumeSend = vi.fn().mockResolvedValue(undefined);
    const member = {
        id: USER_ID,
        toString: () => SUBJECT_MENTION,
        user: { id: USER_ID, username: 'spicypete', send: resumeSend },
        roles: { add: vi.fn(), cache: { has: () => false } },
    };
    const guild = { id: GUILD_ID, name: 'Afterdark', members: { fetch: vi.fn().mockResolvedValue(member) } };

    return {
        client: {
            user: { id: 'bot-1' },
            guilds: { cache: { get: () => guild }, fetch: vi.fn().mockResolvedValue(guild) },
        } as unknown as Client,
        resumeSend,
    };
}

/** `producer -> consumer`, with whatever the consumer says in its DM. */
function producerThenDm(options: { outputKey: string; value: string; message: string }): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'trigger', type: 'trigger.buttonClick', position: { x: 0, y: 0 }, data: { label: 'Go' } },
            {
                id: 'producer',
                type: ACTION_RECORD_VALUE,
                position: { x: 1, y: 0 },
                data: { outputKey: options.outputKey, value: options.value },
            },
            {
                id: 'consumer',
                type: 'action.sendDM',
                position: { x: 2, y: 0 },
                data: { message: options.message },
            },
        ],
        edges: [
            { id: 'e1', source: 'trigger', target: 'producer' },
            { id: 'e2', source: 'producer', target: 'consumer' },
        ],
    } as FlowGraph;
}

describe('a block consumes a value another block produced', () => {
    it('reads it through {{var.<name>}} in the consumer’s copy', async () => {
        // This is step 2's bar in one assertion.
        const { context, userSend } = makeSeed();
        const graph = producerThenDm({
            outputKey: 'ticketChannelId',
            value: '998877',
            message: 'Your ticket is <#{{var.ticketChannelId}}>. Behave.',
        });

        const result = await executeFlow('flow-1', graph, 'trigger', context);

        expect(result.status).toBe('success');
        expect(sentCopy(userSend)).toEqual(['Your ticket is <#998877>. Behave.']);
    });

    it('addresses the subject in copy', async () => {
        const { context, userSend } = makeSeed();
        const graph = producerThenDm({
            outputKey: 'unused',
            value: 'x',
            message: 'Welcome {{subject.mention}} — {{subject.username}} to {{guild.name}}.',
        });

        await executeFlow('flow-1', graph, 'trigger', context);

        expect(sentCopy(userSend)).toEqual([`Welcome ${SUBJECT_MENTION} — spicypete to Afterdark.`]);
    });

    it('does not let one node see another node’s write channel', async () => {
        // The hazard the unconditional per-node rebuild exists to prevent: if the
        // context object were shared, the second producer's writer would still be
        // the first's and the last value would land under the wrong key.
        const { context, userSend } = makeSeed();
        const graph: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                { id: 'trigger', type: 'trigger.buttonClick', position: { x: 0, y: 0 }, data: { label: 'Go' } },
                { id: 'p1', type: ACTION_RECORD_VALUE, position: { x: 1, y: 0 }, data: { outputKey: 'first', value: 'alpha' } },
                { id: 'p2', type: ACTION_RECORD_VALUE, position: { x: 2, y: 0 }, data: { outputKey: 'second', value: 'beta' } },
                { id: 'dm', type: 'action.sendDM', position: { x: 3, y: 0 }, data: { message: '{{var.first}}/{{var.second}}' } },
            ],
            edges: [
                { id: 'e1', source: 'trigger', target: 'p1' },
                { id: 'e2', source: 'p1', target: 'p2' },
                { id: 'e3', source: 'p2', target: 'dm' },
            ],
        } as FlowGraph;

        await executeFlow('flow-1', graph, 'trigger', context);

        expect(sentCopy(userSend)).toEqual(['alpha/beta']);
    });

    it('leaves the caller’s own context untouched', async () => {
        // A mutated shared context would leak one run's values back to the
        // dispatcher that started it.
        const { context } = makeSeed();
        const graph = producerThenDm({ outputKey: 'k', value: 'v', message: 'hi' });

        await executeFlow('flow-1', graph, 'trigger', context);

        expect(context.variables).toEqual({});
    });

    it('fails the run nameably when a consumer reads a value nothing produced', async () => {
        const { context, userSend } = makeSeed();
        const graph = producerThenDm({
            outputKey: 'somethingElse',
            value: 'x',
            message: 'ticket {{var.neverWritten}}',
        });

        const result = await executeFlow('flow-1', graph, 'trigger', context);

        expect(result.status).toBe('error');
        expect(result.error).toContain('neverWritten');
        // And nothing half-rendered was sent.
        expect(userSend).not.toHaveBeenCalled();
    });

    it('renders a pre-slice graph with no tokens completely unchanged', async () => {
        const { context, userSend } = makeSeed();
        const untouched = 'Rules: be excellent to each other. No exceptions.';
        const graph = producerThenDm({ outputKey: 'k', value: 'v', message: untouched });

        const result = await executeFlow('flow-1', graph, 'trigger', context);

        expect(result.status).toBe('success');
        expect(sentCopy(userSend)).toEqual([untouched]);
    });

    it('fails nameably when the rendered copy overflows the field’s limit', async () => {
        // `action.sendDM` declares maxLength 2000. The template is well under it
        // and the rendered result is well over — the case a pre-render check misses.
        const { context, userSend } = makeSeed();
        const graph = producerThenDm({
            outputKey: 'blurb',
            value: 'x'.repeat(2100),
            message: '{{var.blurb}}',
        });

        const result = await executeFlow('flow-1', graph, 'trigger', context);

        expect(result.status).toBe('error');
        expect(result.error).toContain('2000');
        expect(userSend).not.toHaveBeenCalled();
    });

    /**
     * Copy one level down: a token inside an `objectList` entry.
     *
     * Worth its own case rather than folded into the scalar ones above, because
     * the executor reaches it by a different path — `isCopyField` narrows to the
     * two single-string arms and does not see a column, so a list field's copy is
     * expanded by a second walk that could be absent while every test above stayed
     * green.
     */
    it('expands a token inside a list entry, not just in a plain copy field', async () => {
        const { context } = makeSeed();
        const channelSend = vi.fn().mockResolvedValue({ id: 'message-1' });
        const seed: FlowRunSeed = {
            ...context,
            client: {
                channels: {
                    fetch: vi.fn().mockResolvedValue({ isTextBased: () => true, send: channelSend }),
                },
            } as unknown as FlowRunSeed['client'],
        };

        const graph: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                { id: 'trigger', type: 'trigger.buttonClick', position: { x: 0, y: 0 }, data: { label: 'Go' } },
                {
                    id: 'embed',
                    type: 'action.postEmbed',
                    position: { x: 1, y: 0 },
                    data: {
                        channelId: 'channel-1',
                        title: 'Welcome',
                        description: 'Say hello.',
                        fields: [
                            { name: 'Who', value: 'It is {{subject.username}}, in {{guild.name}}.' },
                        ],
                    },
                },
            ],
            edges: [{ id: 'e1', source: 'trigger', target: 'embed' }],
        } as FlowGraph;

        const result = await executeFlow('flow-1', graph, 'trigger', seed);

        expect(result.status).toBe('success');
        const payload = channelSend.mock.calls[0]?.[0] as { embeds: { data: unknown }[] };
        expect((payload.embeds[0] as { data: { fields?: unknown } }).data.fields).toEqual([
            { name: 'Who', value: 'It is spicypete, in Afterdark.', inline: false },
        ]);
    });

    it('stops the run when the bag outgrows its cap, rather than dropping a value', async () => {
        const { context } = makeSeed();
        const graph = producerThenDm({
            outputKey: 'huge',
            value: 'x'.repeat(FLOW_MAX_VARIABLES_SIZE + 1),
            message: 'hi',
        });

        const result = await executeFlow('flow-1', graph, 'trigger', context);

        expect(result.status).toBe('error');
        expect(result.error).toContain(String(FLOW_MAX_VARIABLES_SIZE));
        expect(result.error).toContain('huge');
    });
});

/**
 * The escalation this slice created, pinned where it can actually happen.
 *
 * Copy became a template here, so a member's own display name now reaches message
 * content for the first time. `action.sendMessage` posts to a **channel**, so a
 * member calling themselves "@everyone" turns the most obvious copy an author
 * will ever write — "Welcome {{subject.username}}" — into a guild-wide ping sent
 * with the bot's permissions, by an unprivileged user, on a `trigger.memberJoin`
 * that needs no approval.
 *
 * Asserted against the channel path deliberately: a DM is 1:1, so pinning the
 * allowlist only there would leave the suite green with the real hole wide open.
 */
describe('a member’s own name cannot ping the guild', () => {
    function channelPostingGraph(message: string): FlowGraph {
        return {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                { id: 'trigger', type: 'trigger.buttonClick', position: { x: 0, y: 0 }, data: { label: 'Go' } },
                {
                    id: 'post',
                    type: 'action.sendMessage',
                    position: { x: 1, y: 0 },
                    data: { channelId: 'channel-1', message },
                },
            ],
            edges: [{ id: 'e1', source: 'trigger', target: 'post' }],
        } as FlowGraph;
    }

    it('pins the mention allowlist when posting rendered copy to a channel', async () => {
        const { context } = makeSeed();
        const send = vi.fn().mockResolvedValue({ id: 'message-1' });
        const channel = { isTextBased: () => true, send };
        (context as { client: unknown }).client = {
            channels: { fetch: vi.fn().mockResolvedValue(channel) },
        };
        (context.subject.user as { username: string }).username = '@everyone';

        const result = await executeFlow('flow-1', channelPostingGraph('Welcome {{subject.username}}!'), 'trigger', context);

        expect(result.status).toBe('success');
        // The text still says what the author wrote — it is the allowlist, not
        // escaping, that makes it inert.
        expect(send).toHaveBeenCalledWith({
            content: 'Welcome @everyone!',
            allowedMentions: { parse: ['users'] },
        });
    });

    it('still lets {{subject.mention}} ping the subject, which is the point of it', async () => {
        const { context } = makeSeed();
        const send = vi.fn().mockResolvedValue({ id: 'message-1' });
        const channel = { isTextBased: () => true, send };
        (context as { client: unknown }).client = {
            channels: { fetch: vi.fn().mockResolvedValue(channel) },
        };

        await executeFlow('flow-1', channelPostingGraph('oi {{subject.mention}}'), 'trigger', context);

        const payload = send.mock.calls[0]?.[0] as { content: string; allowedMentions: { parse: string[] } };
        expect(payload.content).toBe(`oi ${SUBJECT_MENTION}`);
        // `users` is what keeps a real mention live while `@everyone` stays inert.
        expect(payload.allowedMentions.parse).toContain('users');
        expect(payload.allowedMentions.parse).not.toContain('everyone');
    });
});

describe('save-time validation of authored copy', () => {
    it('rejects an unknown token, naming the node', async () => {
        const graph = producerThenDm({ outputKey: 'k', value: 'v', message: 'hi {{subject.nmae}}' });

        const result = validateAuthoredGraph(graph);

        expect(result.valid).toBe(false);
        if (result.valid) throw new Error('unreachable');
        expect(result.errors.join(' ')).toContain('consumer');
        expect(result.errors.join(' ')).toContain('{{subject.nmae}}');
    });

    it('rejects a bare nonsense token', () => {
        const graph = producerThenDm({ outputKey: 'k', value: 'v', message: '{{nonsense}}' });

        expect(validateAuthoredGraph(graph).valid).toBe(false);
    });

    it('accepts any {{var.<name>}}, because blocks do not declare outputs yet', () => {
        // Deliberate scope note: there is no vocabulary of produced names to check
        // against until outputs are real, so accepting is the honest answer. A
        // value nothing produces still fails at runtime, by name.
        const graph = producerThenDm({ outputKey: 'k', value: 'v', message: '{{var.anythingAtAll}}' });

        expect(validateAuthoredGraph(graph).valid).toBe(true);
    });

    it('accepts the tokens the engine can fill in', () => {
        const graph = producerThenDm({
            outputKey: 'k',
            value: 'v',
            message: '{{subject.mention}} {{subject.username}} {{actor.mention}} {{guild.name}}',
        });

        expect(validateAuthoredGraph(graph).valid).toBe(true);
    });

    it('rejects an unknown token inside a list entry, naming the column and the row', () => {
        // Save-time's half of the case above: copy inside an entry is found by a
        // different walk from copy at a config key, so it could be unchecked here
        // while every assertion above passed.
        const graph: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                { id: 'trigger', type: 'trigger.buttonClick', position: { x: 0, y: 0 }, data: { label: 'Go' } },
                {
                    id: 'embed',
                    type: 'action.postEmbed',
                    position: { x: 1, y: 0 },
                    data: {
                        channelId: 'channel-1',
                        title: 'T',
                        description: 'D',
                        fields: [{ name: 'Who', value: 'hi {{subject.nmae}}' }],
                    },
                },
            ],
            edges: [{ id: 'e1', source: 'trigger', target: 'embed' }],
        } as FlowGraph;

        const result = validateAuthoredGraph(graph);

        expect(result.valid).toBe(false);
        if (result.valid) throw new Error('unreachable');
        const message = result.errors.join(' ');
        expect(message).toContain('{{subject.nmae}}');
        // The row number is what makes it actionable on a list of twenty.
        expect(message).toContain('entry 1');
    });

    it('ignores braces in a field that does not carry copy', async () => {
        // The producer's `value` is not `rendersTokens`, so it is data and not a
        // template — validating it would reject a perfectly good literal.
        const graph = producerThenDm({ outputKey: 'k', value: '{{not a token}}', message: 'hi' });

        expect(validateAuthoredGraph(graph).valid).toBe(true);
    });

    it('still accepts a graph saved before any of this existed', () => {
        const graph = producerThenDm({ outputKey: 'k', value: 'v', message: 'plain copy, no braces' });

        expect(validateAuthoredGraph(graph).valid).toBe(true);
    });
});

/**
 * The half of the design that justifies `setOutput` existing at all.
 *
 * A producer, a block that parks, and a consumer after the wait — driven through
 * the real repo so the bag is serialised, stored, read back and reseeded. Written
 * deliberately as a *second* park through `flowRunsRepo`, because the obvious
 * version of this test passes entirely inside one `executeFlowSegment` call and
 * never touches persistence at all.
 */
describe('a recorded value survives a park and resume', () => {
    let testDb: FlowRunsTestDb;
    let repo: FlowRunsRepo;

    beforeEach(async () => {
        testDb = await createFlowRunsTestDb();
        repo = new FlowRunsRepo(testDb.db);
    });

    afterEach(async () => {
        await testDb.db.destroy();
    });

    /** producer -> delay -> DM that reads what the producer recorded. */
    const graph: FlowGraph = {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'trigger', type: 'trigger.buttonClick', position: { x: 0, y: 0 }, data: { label: 'Go' } },
            {
                id: 'producer',
                type: ACTION_RECORD_VALUE,
                position: { x: 1, y: 0 },
                data: { outputKey: 'ticketChannelId', value: '4242' },
            },
            { id: 'delay', type: 'action.delay', position: { x: 2, y: 0 }, data: { durationMs: 60_000 } },
            {
                id: 'consumer',
                type: 'action.sendDM',
                position: { x: 3, y: 0 },
                data: { message: 'Still open: <#{{var.ticketChannelId}}>' },
            },
        ],
        edges: [
            { id: 'e1', source: 'trigger', target: 'producer' },
            { id: 'e2', source: 'producer', target: 'delay' },
            { id: 'e3', source: 'delay', target: 'consumer' },
        ],
    } as FlowGraph;

    it('is written to the row when the run parks, and read back when it wakes', async () => {
        const { context, userSend } = makeSeed();

        // Leg one: run until the delay parks it, persisting through the real repo.
        const first = await executeFlow('flow-1', graph, 'trigger', context, async (suspension) => {
            await repo.create({
                flowId: 'flow-1',
                guildId: GUILD_ID,
                contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
                resumeNodeId: suspension.resumeNodeId,
                wakeAt: suspension.wakeAt ?? null,
                visitsUsed: suspension.visitsUsed,
                log: suspension.log,
                variables: suspension.variables,
                runId: 'run-1',
            });
        });

        expect(first.status).toBe('success');
        expect(userSend).not.toHaveBeenCalled();

        // The value is genuinely in the database, not merely in memory.
        const parked = await repo.getByRunId('run-1');
        expect(parked?.variables).toEqual({ ticketChannelId: '4242' });

        // Leg two: wake it through the real resume path.
        const flow = { flowId: 'flow-1', guildId: GUILD_ID, graph, enabled: true } as FlowEntity;
        const { client, resumeSend } = makeResumeClient();

        if (!parked) throw new Error('the parked run disappeared');
        const outcome = await resumeFlowRun(client, parked, RESUME_TIMEOUT, {
            flowsRepo: { getByFlowId: vi.fn().mockResolvedValue(flow) },
            flowRunsRepo: repo,
        });

        expect(outcome.status).toBe('completed');
        // The whole point: a value recorded before the park reached a block that
        // ran after it, through the database.
        expect(sentCopy(resumeSend)).toEqual(['Still open: <#4242>']);
    });

    it('carries the bag through a segment that parks again', async () => {
        // Re-parking goes through `repo.park`, a different write from `create` —
        // and one that would silently drop the bag if it did not carry it.
        const { context } = makeSeed();

        const outcome = await executeFlowSegment('flow-1', graph, context, {
            runId: 'run-1',
            startNodeId: 'trigger',
            requireTrigger: true,
        });

        if (outcome.kind !== 'suspended') {
            throw new Error('expected the delay to park the run');
        }
        expect(outcome.suspension.variables).toEqual({ ticketChannelId: '4242' });

        await repo.create({
            flowId: 'flow-1',
            guildId: GUILD_ID,
            contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
            resumeNodeId: outcome.suspension.resumeNodeId,
            wakeAt: outcome.suspension.wakeAt ?? null,
            visitsUsed: outcome.suspension.visitsUsed,
            log: outcome.suspension.log,
            runId: 'run-2',
        });
        await repo.claimForResume('run-2');
        await repo.park('run-2', {
            resumeNodeId: outcome.suspension.resumeNodeId,
            wakeAt: outcome.suspension.wakeAt,
            visitsUsed: outcome.suspension.visitsUsed,
            log: outcome.suspension.log,
            variables: outcome.suspension.variables,
        });

        const reparked = await repo.getByRunId('run-2');
        expect(reparked?.variables).toEqual({ ticketChannelId: '4242' });
    });

    it('hands a resumed run a bag that inherits nothing, as the writing leg did', async () => {
        // A row that has been through JSON and Zod comes back an ordinary object,
        // so `{{var.toString}}` would resolve on a resumed run while failing on a
        // fresh one — the same graph behaving differently either side of a wait.
        const run = await repo.create({
            flowId: 'flow-1',
            guildId: GUILD_ID,
            contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
            resumeNodeId: 'delay',
            visitsUsed: 1,
            variables: { ticketChannelId: '1234' },
        });

        const rebuilt = await rebuildResumeContext(makeResumeClient().client, run);

        if (!rebuilt.ok) throw new Error(rebuilt.reason);
        expect(Object.getPrototypeOf(rebuilt.context.variables)).toBeNull();
        expect(rebuilt.context.variables).toEqual({ ticketChannelId: '1234' });
    });

    it('gives a resumed run whatever the row recorded, not an empty bag', async () => {
        // `rebuildResumeContext` seeding from the row is the single line that makes
        // all of this work; without it every value silently vanishes at a wait.
        const flow = { flowId: 'flow-1', guildId: GUILD_ID, graph, enabled: true } as FlowEntity;
        const { client, resumeSend } = makeResumeClient();

        // A row parked at the consumer, carrying a value written before the park.
        const run = await repo.create({
            flowId: 'flow-1',
            guildId: GUILD_ID,
            contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
            resumeNodeId: 'delay',
            wakeAt: new Date(Date.now() - 1000),
            visitsUsed: 3,
            variables: { ticketChannelId: '7777' },
        });

        const outcome = await resumeFlowRun(client, run, RESUME_TIMEOUT, {
            flowsRepo: { getByFlowId: vi.fn().mockResolvedValue(flow) },
            flowRunsRepo: repo,
        });

        expect(outcome.status).toBe('completed');
        expect(sentCopy(resumeSend)).toEqual(['Still open: <#7777>']);
    });
});

describe('the producer fixture is a real block', () => {
    it('is discovered and run through the registry like any other', () => {
        // If this ever stops being true the tests above are proving something
        // weaker than they claim — a stub, not a block.
        expect(getBlockDefinition(ACTION_RECORD_VALUE)?.label).toBe('Record Value');
    });

    it('is not in the shipped palette', async () => {
        const shipped = await discoverBlocks<BlockManifest>();
        expect([...shipped.keys()]).not.toContain(ACTION_RECORD_VALUE);
    });
});
