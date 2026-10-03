import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureBlocksDiscovered } from '../../blocks/registry';
import { TRIGGER_MEMBER_JOIN } from '../../blocks/triggerMemberJoin';
import { TRIGGER_MESSAGE_SENT } from '../../blocks/triggerMessageSent';
import { FLOW_MESSAGE_TRIGGER_READ_FAILURE_WINDOW_MS } from '../../constants';
import { FLOW_GRAPH_VERSION, type FlowNode } from '../../data/flowGraph';
import type { FlowEntity } from '../../data/flowsSchema';
import { MessageTriggerIndex, type MessageWhere } from '../messageTriggerIndex';

/**
 * The in-memory index of Message Sent triggers: how it loads, what it holds, and when it
 * lets go. The live wiring — a real save dropping it, a real message reading it — is in
 * `__tests__/messageSent.test.ts`.
 */

beforeAll(ensureBlocksDiscovered);

const GUILD = 'guild-1';
const NOW = new Date('2026-10-03T12:00:00.000Z').getTime();
const ELSEWHERE: MessageWhere = { channelId: 'elsewhere', parentChannelId: null, categoryId: null };

function trigger(id: string, data: Record<string, unknown>): FlowNode {
    return { id, type: TRIGGER_MESSAGE_SENT, position: { x: 0, y: 0 }, data };
}

function flow(flowId: string, nodes: FlowNode[], enabled = true): FlowEntity {
    return {
        id: 1,
        flowId,
        guildId: GUILD,
        name: flowId,
        enabled,
        graph: { version: FLOW_GRAPH_VERSION, nodes, edges: [] },
        entityVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
    };
}

/** A repo answering `getByGuildId` from a list a test can change, counting reads. */
function repoOf(flows: () => FlowEntity[] | Promise<FlowEntity[]>) {
    return { getByGuildId: vi.fn(async (_guildId: string) => flows()) };
}

/** The node ids an index matches for a message posted at `where`. */
async function matched(index: MessageTriggerIndex, where: MessageWhere): Promise<string[]> {
    const triggers = await index.forGuild(GUILD);
    return triggers?.matching(where).map((entry) => entry.nodeId) ?? [];
}

describe('the Message Sent trigger index', () => {
    it('buckets each trigger by where it listens, in flow and node order', async () => {
        const index = new MessageTriggerIndex(
            repoOf(() => [
                flow('a', [
                    trigger('in-category', { where: 'category', categoryId: 'dungeon' }),
                    trigger('anywhere', { where: 'anywhere' }),
                ]),
                flow('b', [trigger('in-channel', { where: 'channel', channelId: 'rules' })]),
            ])
        );

        expect(await matched(index, ELSEWHERE)).toEqual(['anywhere']);
        expect(await matched(index, { channelId: 'rules', parentChannelId: null, categoryId: null })).toEqual([
            'anywhere',
            'in-channel',
        ]);
        // A thread under #rules, in a channel inside the category.
        expect(await matched(index, { channelId: 'thread', parentChannelId: 'rules', categoryId: 'dungeon' })).toEqual([
            'in-category',
            'anywhere',
            'in-channel',
        ]);
    });

    it('skips disabled flows, other triggers, and a node that does not parse', async () => {
        const index = new MessageTriggerIndex(
            repoOf(() => [
                flow('off', [trigger('disabled', { where: 'anywhere' })], false),
                flow('on', [
                    { id: 'join', type: TRIGGER_MEMBER_JOIN, position: { x: 0, y: 0 }, data: {} },
                    // A channel scope with no channel matches nothing rather than everything.
                    trigger('unfinished', { where: 'channel' }),
                    trigger('fine', { where: 'anywhere' }),
                ]),
            ])
        );

        expect(await matched(index, ELSEWHERE)).toEqual(['fine']);
    });

    it('reads a node as the executor does, ignoring a field its scope hides', async () => {
        // The builder seeds every default and switching scope clears nothing, so an
        // "Anywhere" trigger can still hold the empty channel a channel scope wrote.
        const index = new MessageTriggerIndex(repoOf(() => [flow('a', [trigger('stale', { where: 'anywhere', channelId: '' })])]));

        expect(await matched(index, ELSEWHERE)).toEqual(['stale']);
    });

    it('keeps the text filter trimmed and lower-cased, and none when it is blank', async () => {
        const index = new MessageTriggerIndex(
            repoOf(() => [
                flow('a', [
                    trigger('filtered', { where: 'anywhere', contains: '  ReAd The RULES ' }),
                    trigger('blank', { where: 'anywhere', contains: '   ' }),
                ]),
            ])
        );

        const triggers = await index.forGuild(GUILD);
        expect(triggers?.matching(ELSEWHERE).map((entry) => entry.text)).toEqual(['read the rules', undefined]);
    });

    it('loads a guild once, sharing the read between messages that arrive together', async () => {
        const repo = repoOf(() => [flow('a', [trigger('anywhere', { where: 'anywhere' })])]);
        const index = new MessageTriggerIndex(repo);

        await Promise.all([index.forGuild(GUILD), index.forGuild(GUILD), index.forGuild(GUILD)]);
        await index.forGuild(GUILD);

        expect(repo.getByGuildId).toHaveBeenCalledTimes(1);
    });

    it('holds a guild with no triggers, so its messages read nothing more', async () => {
        const repo = repoOf(() => []);
        const index = new MessageTriggerIndex(repo);

        for (let message = 0; message < 5; message += 1) {
            expect((await index.forGuild(GUILD))?.isEmpty).toBe(true);
        }

        expect(repo.getByGuildId).toHaveBeenCalledTimes(1);
    });

    it('leaves a guild whose load failed alone for a window — no read, no log — then tries again', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const repo = repoOf(() => [flow('a', [trigger('anywhere', { where: 'anywhere' })])]);
        repo.getByGuildId.mockRejectedValueOnce(new Error('one bad graph'));
        const index = new MessageTriggerIndex(repo);

        expect(await index.forGuild(GUILD, NOW)).toBeUndefined();
        // Every message inside the window: nothing held, nothing read, nothing logged.
        expect(await index.forGuild(GUILD, NOW + 1)).toBeUndefined();
        expect(await index.forGuild(GUILD, NOW + FLOW_MESSAGE_TRIGGER_READ_FAILURE_WINDOW_MS - 1)).toBeUndefined();
        expect(repo.getByGuildId).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledTimes(1);

        // The first message after it reads again.
        const triggers = await index.forGuild(GUILD, NOW + FLOW_MESSAGE_TRIGGER_READ_FAILURE_WINDOW_MS);
        expect(triggers?.matching(ELSEWHERE).map((entry) => entry.nodeId)).toEqual(['anywhere']);
        expect(repo.getByGuildId).toHaveBeenCalledTimes(2);
        error.mockRestore();
    });

    it('reads a guild whose load failed again straight after a flow write', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const repo = repoOf(() => [flow('a', [trigger('fixed', { where: 'anywhere' })])]);
        repo.getByGuildId.mockRejectedValueOnce(new Error('one bad graph'));
        const index = new MessageTriggerIndex(repo);

        expect(await index.forGuild(GUILD, NOW)).toBeUndefined();
        index.invalidate();

        const triggers = await index.forGuild(GUILD, NOW + 1);
        expect(triggers?.matching(ELSEWHERE).map((entry) => entry.nodeId)).toEqual(['fixed']);
        expect(repo.getByGuildId).toHaveBeenCalledTimes(2);
        error.mockRestore();
    });

    it('does not mark a guild for a failed load that began before a flow write', async () => {
        // The write may be the fix; the next message reads it rather than waiting.
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        let fail!: (reason: Error) => void;
        const repo = repoOf(() => [flow('a', [trigger('fixed', { where: 'anywhere' })])]);
        repo.getByGuildId.mockImplementationOnce(() => new Promise<FlowEntity[]>((_resolve, reject) => (fail = reject)));
        const index = new MessageTriggerIndex(repo);

        const early = index.forGuild(GUILD, NOW);
        index.invalidate();
        fail(new Error('read before the fix'));
        expect(await early).toBeUndefined();

        const triggers = await index.forGuild(GUILD, NOW + 1);
        expect(triggers?.matching(ELSEWHERE).map((entry) => entry.nodeId)).toEqual(['fixed']);
        error.mockRestore();
    });

    it('reads again after an invalidation', async () => {
        let flows = [flow('a', [trigger('first', { where: 'anywhere' })])];
        const repo = repoOf(() => flows);
        const index = new MessageTriggerIndex(repo);
        expect(await matched(index, ELSEWHERE)).toEqual(['first']);

        flows = [flow('a', [trigger('second', { where: 'anywhere' })])];
        expect(await matched(index, ELSEWHERE)).toEqual(['first']);

        index.invalidate();
        expect(await matched(index, ELSEWHERE)).toEqual(['second']);
    });

    it('does not keep a load that began before an invalidation', async () => {
        // The read in flight saw the flows as they were before the write; the messages
        // already waiting on it get that answer, and nobody after them does.
        let release!: (flows: FlowEntity[]) => void;
        const repo = repoOf(() => new Promise<FlowEntity[]>((resolve) => (release = resolve)));
        const index = new MessageTriggerIndex(repo);

        const early = index.forGuild(GUILD);
        index.invalidate();
        release([flow('a', [trigger('before-the-write', { where: 'anywhere' })])]);
        expect((await early)?.matching(ELSEWHERE).map((entry) => entry.nodeId)).toEqual(['before-the-write']);

        repo.getByGuildId.mockResolvedValueOnce([flow('a', [trigger('after-the-write', { where: 'anywhere' })])]);
        expect(await matched(index, ELSEWHERE)).toEqual(['after-the-write']);
        expect(repo.getByGuildId).toHaveBeenCalledTimes(2);
    });
});
