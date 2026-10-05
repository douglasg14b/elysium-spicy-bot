import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlockManifest } from '../blocks/manifest';
import { ensureBlocksDiscovered } from '../blocks/registry';
import { RESUME_TIMEOUT, type FlowRunSeed } from '../blocks/types';
import { FLOW_GRAPH_VERSION, type FlowGraph, type FlowNode } from '../data/flowGraph';
import { FlowRunsRepo, flowRunsRepo } from '../data/flowRunsRepo';
import type { FlowRunEntity } from '../data/flowRunsSchema';
import type { FlowEntity } from '../data/flowsSchema';
import {
    createFlowRunsTestDb,
    type FlowRunsTestDb,
} from '../../../features-system/data-persistence/__tests__/support/flowRunsTestDb';
import { executeFlow } from '../engine/executor';
import { rebuildResumeContext, resumeFlowRun } from '../engine/flowRunResume';
import { authoredGraphIssues } from '../engine/graphValidation';
import type { FlowValidationIssue } from '../engine/nodeDataValidation';
import { FIXTURE_ACTION_DECLARES_SUBJECT } from './fixtures/blocks/subjectAbsent/actionDeclaresSubject';
import { FIXTURE_ACTION_HIDDEN_CHOICE } from './fixtures/blocks/subjectAbsent/actionHiddenChoice';
import { FIXTURE_TRIGGER_SUPPLIES_NOBODY } from './fixtures/blocks/subjectAbsent/triggerSuppliesNobody';
import { sentCopy } from './support/sentCopy';

/**
 * Runs about nobody: a trigger that declares no `subject` starts runs with no member,
 * and everything downstream has to know what that means.
 *
 * Driven from a test-only trigger (no `startedBy`, so no dispatcher selects it) through
 * the real validator, the real executor and the real park-and-resume path, because the
 * property lives across all three: save refuses what needs a member where a run about
 * nobody reaches, the executor refuses it by name if one gets there anyway, and a run
 * that parks with no member resumes with no member rather than failing as "left".
 */

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';
const CHANNEL_ID = 'channel-1';
const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'blocks', 'subjectAbsent');

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

const SUBJECT_ISSUE = /needs "subject" from the run.*a trigger whose runs are about nobody/;

function node(id: string, type: string, data: Record<string, unknown> = {}): FlowNode {
    return { id, type, position: { x: 0, y: 0 }, data };
}

/** `trigger -> target`, where `trigger` is the given trigger node. */
function graphFrom(trigger: FlowNode, ...chain: FlowNode[]): FlowGraph {
    const nodes = [trigger, ...chain];
    return {
        version: FLOW_GRAPH_VERSION,
        nodes,
        edges: nodes.slice(1).map((target, index) => ({
            id: `e${index}`,
            source: nodes[index]?.id ?? '',
            target: target.id,
        })),
    };
}

const nobody = (): FlowNode => node('trigger', FIXTURE_TRIGGER_SUPPLIES_NOBODY);
const joined = (): FlowNode => node('trigger', 'trigger.memberJoin');
const button = (): FlowNode => node('trigger', 'trigger.buttonClick', { channelId: CHANNEL_ID, label: 'Go' });

/** Every issue on one node. */
function issuesOn(graph: FlowGraph, nodeId: string): FlowValidationIssue[] {
    return authoredGraphIssues(graph).filter((issue) => issue.nodeId === nodeId);
}

function subjectIssuesOn(graph: FlowGraph, nodeId: string): FlowValidationIssue[] {
    return issuesOn(graph, nodeId).filter((issue) => SUBJECT_ISSUE.test(issue.message));
}

/** The nodes, each with the config its path needs, that a run about nobody cannot reach. */
const NEEDS_A_MEMBER: readonly { readonly name: string; readonly node: () => FlowNode; readonly cause?: RegExp }[] = [
    { name: 'a block that acts on the member', node: () => node('target', 'action.assignRole', { roleId: 'role-1' }) },
    {
        name: '{{subject.mention}} in a copy field',
        node: () => node('target', 'action.sendMessage', { channelId: CHANNEL_ID, message: 'Hey {{subject.mention}}' }),
        cause: /for \{\{subject\.mention\}\} in "Message"/,
    },
    {
        name: '{{subject.username}} in an objectList column',
        node: () =>
            node('target', 'action.postEmbed', {
                channelId: CHANNEL_ID,
                title: 'Roll call',
                fields: [{ name: 'Who', value: '{{subject.username}}', inline: false }],
            }),
        cause: /for \{\{subject\.username\}\} in "Fields" Text on entry 1/,
    },
    {
        name: "a quiet window counting the member's messages",
        node: () => node('target', 'action.delay', { durationMs: 60_000, timeoutCountsFrom: 'memberMessage' }),
        cause: /for "Count the time limit from" set to "The member's last message"/,
    },
    {
        name: "Time Since from the member's last message",
        node: () => node('target', 'condition.timeSince', { source: 'memberMessage', durationMs: 60_000 }),
        cause: /for "Since" set to "The member's last message"/,
    },
    {
        name: 'Time Since from when the member joined',
        node: () => node('target', 'condition.timeSince', { source: 'memberJoined', durationMs: 60_000 }),
        cause: /for "Since" set to "When the member joined"/,
    },
    {
        name: 'Time Since left on its default source',
        node: () => node('target', 'condition.timeSince', { durationMs: 60_000 }),
        cause: /for "Since" set to "The member's last message"/,
    },
    { name: 'Wait for Event', node: () => node('target', 'action.waitForEvent', { eventKind: 'reactionAdd' }) },
    { name: 'Ask a Question', node: () => node('target', 'action.prompt', { question: 'Well?', choices: ['Yes'] }) },
];

describe('save refuses what needs a member where a run about nobody reaches', () => {
    it.each(NEEDS_A_MEMBER)('refuses $name', ({ node: build, cause }) => {
        const issues = subjectIssuesOn(graphFrom(nobody(), build()), 'target');

        expect(issues).toHaveLength(1);
        expect(issues[0]?.message).toMatch(/Remove it, or start this path from a trigger about a member\./);
        if (cause) expect(issues[0]?.message).toMatch(cause);
    });

    it.each(NEEDS_A_MEMBER)('accepts $name from a trigger about a member', ({ node: build }) => {
        expect(subjectIssuesOn(graphFrom(joined(), build()), 'target')).toEqual([]);
        expect(subjectIssuesOn(graphFrom(button(), build()), 'target')).toEqual([]);
    });

    it("places an option's finding under its field, and leaves a token's at node level", () => {
        const option = subjectIssuesOn(graphFrom(nobody(), NEEDS_A_MEMBER[4]?.node() ?? nobody()), 'target');
        const token = subjectIssuesOn(graphFrom(nobody(), NEEDS_A_MEMBER[1]?.node() ?? nobody()), 'target');
        const column = subjectIssuesOn(graphFrom(nobody(), NEEDS_A_MEMBER[2]?.node() ?? nobody()), 'target');
        const block = subjectIssuesOn(graphFrom(nobody(), NEEDS_A_MEMBER[0]?.node() ?? nobody()), 'target');

        expect(option[0]?.field).toBe('source');
        // A token's finding is not placed under its copy field: the builder drops a field's
        // server issue on the first keystroke, and its live checks cannot see requirements.
        expect(token[0]?.field).toBeUndefined();
        expect(column[0]?.field).toBeUndefined();
        expect(block[0]?.field).toBeUndefined();
    });

    it('accepts Time Since measuring from a channel, which needs no member', () => {
        const graph = graphFrom(
            nobody(),
            node('target', 'condition.timeSince', { source: 'channelMessage', channelId: CHANNEL_ID, durationMs: 60_000 })
        );

        expect(issuesOn(graph, 'target')).toEqual([]);
    });

    it('accepts copy whose only token needs nothing', () => {
        const graph = graphFrom(
            nobody(),
            node('target', 'action.sendMessage', { channelId: CHANNEL_ID, message: 'Hello, {{guild.name}}' })
        );

        expect(issuesOn(graph, 'target')).toEqual([]);
    });

    it('ignores a member option and a member token in fields their visibleWhen hides', () => {
        // Hidden means absent to every reader: a node still holding a member choice and a
        // member mention in fields its mode hides needs nothing from them.
        const hidden = { who: 'member', note: 'Hey {{subject.mention}}' };

        expect(subjectIssuesOn(graphFrom(nobody(), node('target', FIXTURE_ACTION_HIDDEN_CHOICE, hidden)), 'target')).toEqual([]);
    });

    it('counts the same option and token once their field shows', () => {
        const option = graphFrom(nobody(), node('target', FIXTURE_ACTION_HIDDEN_CHOICE, { mode: 'detailed', who: 'member' }));
        const token = graphFrom(
            nobody(),
            node('target', FIXTURE_ACTION_HIDDEN_CHOICE, { mode: 'detailed', who: 'anyone', note: 'Hey {{subject.mention}}' })
        );

        expect(subjectIssuesOn(option, 'target')[0]?.message).toMatch(/for "Who" set to "The member"/);
        expect(subjectIssuesOn(token, 'target')[0]?.message).toMatch(/for \{\{subject\.mention\}\} in "Note"/);
    });

    it('refuses only the nodes the trigger about nobody reaches, in a flow with both kinds', () => {
        const graph: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                node('nobody', FIXTURE_TRIGGER_SUPPLIES_NOBODY),
                node('member', 'trigger.memberJoin'),
                node('reachedByNobody', 'action.assignRole', { roleId: 'role-1' }),
                node('reachedByMember', 'action.assignRole', { roleId: 'role-2' }),
                node('reachedByBoth', 'action.removeRole', { roleId: 'role-3' }),
            ],
            edges: [
                { id: 'e1', source: 'nobody', target: 'reachedByNobody' },
                { id: 'e2', source: 'member', target: 'reachedByMember' },
                { id: 'e3', source: 'reachedByNobody', target: 'reachedByBoth' },
                { id: 'e4', source: 'reachedByMember', target: 'reachedByBoth' },
            ],
        };

        expect(subjectIssuesOn(graph, 'reachedByNobody')).toHaveLength(1);
        expect(subjectIssuesOn(graph, 'reachedByBoth')).toHaveLength(1);
        expect(subjectIssuesOn(graph, 'reachedByMember')).toEqual([]);
    });

    it('does not flag a block nothing reaches', () => {
        const graph: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [nobody(), node('loose', 'action.assignRole', { roleId: 'role-1' })],
            edges: [],
        };

        expect(subjectIssuesOn(graph, 'loose')).toEqual([]);
    });
});

describe('{{actor.mention}} is held to the same rule', () => {
    const ACTOR_ISSUE = /needs "actor" from the run for \{\{actor\.mention\}\} in "Message", but it can be reached after a block that parks the run/;

    it('is refused after a block that parks the run', () => {
        const graph = graphFrom(
            joined(),
            node('wait', 'action.delay', { durationMs: 60_000 }),
            node('target', 'action.sendMessage', { channelId: CHANNEL_ID, message: 'Thanks {{actor.mention}}' })
        );

        const issues = issuesOn(graph, 'target');

        expect(issues.map((issue) => issue.message).join('\n')).toMatch(ACTOR_ISSUE);
    });

    it("is refused in a parking block's own copy, which is rendered again on every wake", () => {
        // The question posts fine on the first leg, but every answer re-enters the block
        // with nobody acting, and its copy is checked again before it runs.
        const graph = graphFrom(
            button(),
            node('ask', 'action.prompt', { question: '{{actor.mention}}, you in?', choices: ['Yes'] }),
            node('after', 'action.sendMessage', { channelId: CHANNEL_ID, message: 'Noted.' })
        );
        graph.edges.push({ id: 'answer', source: 'ask', sourceHandle: 'choice-0', target: 'after' });

        expect(issuesOn(graph, 'ask').map((issue) => issue.message).join('\n')).toMatch(
            /needs "actor" from the run for \{\{actor\.mention\}\} in "Question", but it can be reached after a block that parks the run, or is one/
        );
    });

    const thanks = () => node('target', 'action.sendMessage', { channelId: CHANNEL_ID, message: 'Thanks {{actor.mention}}' });

    it("is refused below Member Leaves, whose trigger doesn't say who acted", () => {
        const graph = graphFrom(node('trigger', 'trigger.memberLeave'), thanks());

        expect(issuesOn(graph, 'target').map((issue) => issue.message).join('\n')).toMatch(
            /needs "actor" from the run for \{\{actor\.mention\}\} in "Message", but it can be reached from a trigger that doesn't say who caused it\. Move it before the wait, or start this path from a trigger where someone acts\./
        );
    });

    it('is accepted below Ticket Event, whose every change names who made it', () => {
        const graph = graphFrom(node('trigger', 'trigger.ticketEvent', { event: 'closed' }), thanks());

        expect(issuesOn(graph, 'target')).toEqual([]);
    });

    it("fails a run whose trigger named nobody by that cause, not by a wait that didn't happen", async () => {
        const result = await executeFlow('flow-1', graphFrom(nobody(), thanks()), 'trigger', seedAboutNobody(world()));

        expect(result.error).toBe(
            'Node target (action.sendMessage) needs whoever caused this step for {{actor.mention}} in "Message", ' +
                "and nobody did — this run's trigger doesn't say who caused it."
        );
    });

    it('is accepted before any park, from a trigger about a member', () => {
        const graph = graphFrom(
            joined(),
            node('target', 'action.sendMessage', { channelId: CHANNEL_ID, message: 'Thanks {{actor.mention}}' })
        );

        expect(issuesOn(graph, 'target')).toEqual([]);
    });
});

/** A guild and client a run about nobody can post in — and nothing to fetch a member from. */
function world() {
    const send = vi.fn().mockResolvedValue({ id: 'message-1' });
    const channel = {
        id: CHANNEL_ID,
        isTextBased: () => true,
        isDMBased: () => false,
        isThread: () => false,
        send,
    };
    const fetchMember = vi.fn().mockRejectedValue(new Error('Unknown Member'));
    const guild = {
        id: GUILD_ID,
        name: 'The Dungeon',
        members: { fetch: fetchMember },
        channels: { cache: { get: () => undefined }, fetch: vi.fn().mockResolvedValue(channel) },
    };
    const client = {
        user: { id: 'bot-1' },
        guilds: { cache: { get: () => guild }, fetch: vi.fn().mockResolvedValue(guild) },
        channels: { fetch: vi.fn().mockResolvedValue(channel) },
    } as unknown as Client;
    return { client, guild, send, fetchMember };
}

function seedAboutNobody(env: ReturnType<typeof world>): FlowRunSeed {
    return {
        client: env.client,
        guild: env.guild as unknown as FlowRunSeed['guild'],
        variables: {},
    };
}

describe('the executor refuses a step that needs what the run does not carry', () => {
    it('fails a block declaring `subject` on a run about nobody, by name, before it runs', async () => {
        const graph = graphFrom(nobody(), node('needy', FIXTURE_ACTION_DECLARES_SUBJECT));

        const result = await executeFlow('flow-1', graph, 'trigger', seedAboutNobody(world()));

        expect(result.status).toBe('error');
        expect(result.error).toBe(
            `Node needy (${FIXTURE_ACTION_DECLARES_SUBJECT}) needs a member, and this run is about nobody.`
        );
        expect(result.log.at(-1)).toMatchObject({ nodeId: 'needy', status: 'error' });
    });

    it('fails a shipped block that acts on the member with the same named failure, not its own throw', async () => {
        const graph = graphFrom(nobody(), node('role', 'action.assignRole', { roleId: 'role-1' }));

        const result = await executeFlow('flow-1', graph, 'trigger', seedAboutNobody(world()));

        expect(result.error).toBe('Node role (action.assignRole) needs a member, and this run is about nobody.');
    });

    it('names the option that needed the member', async () => {
        const graph = graphFrom(nobody(), node('since', 'condition.timeSince', { source: 'memberJoined', durationMs: 60_000 }));

        const result = await executeFlow('flow-1', graph, 'trigger', seedAboutNobody(world()));

        expect(result.error).toBe(
            'Node since (condition.timeSince) needs a member for "Since" set to "When the member joined", ' +
                'and this run is about nobody.'
        );
    });

    it('names the token that needed the member, before anything is posted', async () => {
        const env = world();
        const graph = graphFrom(
            nobody(),
            node('say', 'action.sendMessage', { channelId: CHANNEL_ID, message: 'Hey {{subject.mention}}' })
        );

        const result = await executeFlow('flow-1', graph, 'trigger', seedAboutNobody(env));

        expect(result.error).toBe(
            'Node say (action.sendMessage) needs a member for {{subject.mention}} in "Message", ' +
                'and this run is about nobody.'
        );
        expect(env.send).not.toHaveBeenCalled();
    });

    it('leaves a missing channel to the block, which treats nowhere as an answer', async () => {
        // A channel deleted while a run was parked resumes as nowhere, deliberately, so
        // In Channel? answers No rather than the executor failing the run.
        const graph = graphFrom(nobody(), node('where', 'condition.inChannel', { channelId: CHANNEL_ID }));

        const result = await executeFlow('flow-1', graph, 'trigger', seedAboutNobody(world()));

        expect(result.status).toBe('success');
        expect(result.log.at(-1)).toMatchObject({ nodeId: 'where', status: 'ok', branch: 'false' });
    });
});

describe('a run about nobody parks and resumes with nobody', () => {
    let testDb: FlowRunsTestDb;
    let repo: FlowRunsRepo;

    beforeEach(async () => {
        testDb = await createFlowRunsTestDb();
        repo = new FlowRunsRepo(testDb.db);
        // Production's default `onSuspend`, pointed at the test database.
        vi.spyOn(flowRunsRepo, 'create').mockImplementation((input) => repo.create(input));
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await testDb.db.destroy();
    });

    /** trigger -> Send Message -> Delay -> Send Message. */
    const graph = graphFrom(
        nobody(),
        node('before', 'action.sendMessage', { channelId: CHANNEL_ID, message: 'Before the wait, {{guild.name}}' }),
        node('delay', 'action.delay', { durationMs: 60_000 }),
        node('after', 'action.sendMessage', { channelId: CHANNEL_ID, message: 'After the wait' })
    );
    const flow = { flowId: 'flow-1', guildId: GUILD_ID, graph, enabled: true } as FlowEntity;

    it('is a graph save accepts', () => {
        expect(authoredGraphIssues(graph)).toEqual([]);
    });

    it('parks with no member in its snapshot, and resumes to the end without fetching one', async () => {
        const env = world();

        const first = await executeFlow('flow-1', graph, 'trigger', seedAboutNobody(env));
        expect(first.status).toBe('success');

        const [parked] = await testDb.db.selectFrom('flow_runs').select('runId').execute();
        if (!parked) throw new Error('the run did not park');
        const row = await repo.getByRunId(parked.runId);
        if (!row) throw new Error('the parked run disappeared');
        expect(row.contextSnapshot.guildId).toBe(GUILD_ID);
        expect(Object.hasOwn(row.contextSnapshot, 'userId')).toBe(false);

        const outcome = await resumeFlowRun(env.client, row, RESUME_TIMEOUT, {
            flowsRepo: { getByFlowId: vi.fn().mockResolvedValue(flow) },
            flowRunsRepo: repo,
        });

        expect(outcome.status).toBe('completed');
        expect(sentCopy(env.send)).toEqual(['Before the wait, The Dungeon', 'After the wait']);
        expect(env.fetchMember).not.toHaveBeenCalled();
    });
});

describe('rebuilding a parked run', () => {
    function parkedRow(contextSnapshot: FlowRunEntity['contextSnapshot']): FlowRunEntity {
        return { runId: 'run-1', guildId: GUILD_ID, contextSnapshot, variables: {} } as unknown as FlowRunEntity;
    }

    it('gives a snapshot with no member no subject, and never asks Discord for one', async () => {
        const env = world();

        const rebuilt = await rebuildResumeContext(env.client, parkedRow({ guildId: GUILD_ID }));

        if (!rebuilt.ok) throw new Error(rebuilt.reason);
        expect(rebuilt.context.subject).toBeUndefined();
        expect(env.fetchMember).not.toHaveBeenCalled();
    });

    it('still fails a snapshot whose member cannot be fetched as one who left', async () => {
        const env = world();

        const rebuilt = await rebuildResumeContext(env.client, parkedRow({ guildId: GUILD_ID, userId: USER_ID }));

        expect(rebuilt).toEqual({ ok: false, reason: `Member ${USER_ID} is no longer in guild ${GUILD_ID}` });
        expect(env.fetchMember).toHaveBeenCalledWith(USER_ID);
    });
});
