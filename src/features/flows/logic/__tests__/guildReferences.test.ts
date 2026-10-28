import { PermissionFlagsBits } from 'discord.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureBlocksDiscovered } from '../../blocks/registry';
import { FLOW_GRAPH_VERSION, type FlowGraph, type FlowNode } from '../../data/flowGraph';
import { fakeGuild } from '../../__tests__/support/fakeGuild';
import { flowReadinessIssuesInGuild } from '../flowReadiness';
import { NEW_FLOW_SCOPE } from '../readinessScope';
import { guildReferenceIssues } from '../guildReferences';

/**
 * What readiness asks of a graph's picked ids that only the flow's own server can answer.
 *
 * The hole this closes: nothing stopped a graph naming another server's channel, and the
 * bot is in more than one server. A flow saved in one could then post as the bot into the
 * other. The guild here holds exactly the ids each case names, so "not in this server"
 * means what it says.
 */

const GUILD_ID = 'guild-1';
const CHANNEL_ID = 'channel-here';
const PLAIN_ROLE_ID = 'role-member';

beforeAll(async () => {
    await ensureBlocksDiscovered();
});

function node(id: string, type: string, data: Record<string, unknown>): FlowNode {
    return { id, type, position: { x: 0, y: 0 }, data };
}

function graphOf(...nodes: FlowNode[]): FlowGraph {
    return { version: FLOW_GRAPH_VERSION, nodes, edges: [] };
}

function guild() {
    return fakeGuild({
        id: GUILD_ID,
        channels: { [CHANNEL_ID]: {} },
        roles: [
            { id: PLAIN_ROLE_ID, name: 'Member' },
            { id: 'role-admin', name: 'Admin', permissions: PermissionFlagsBits.Administrator },
            { id: 'role-mod', name: 'Mod', permissions: PermissionFlagsBits.KickMembers | PermissionFlagsBits.BanMembers },
            { id: 'role-bot', name: 'Some Bot', managed: true },
            { id: GUILD_ID, name: '@everyone' },
        ],
    });
}

describe('a picked channel', () => {
    it("is refused on its node and field when it is not one of this server's", () => {
        const graph = graphOf(
            node('post', 'action.sendMessage', { channelId: 'another-servers-channel', message: 'hi' })
        );

        expect(guildReferenceIssues(graph, guild())).toEqual([
            { nodeId: 'post', field: 'channelId', message: expect.stringMatching(/isn't in this server/) },
        ]);
    });

    it('passes when it is in this server', () => {
        const graph = graphOf(node('post', 'action.sendMessage', { channelId: CHANNEL_ID, message: 'hi' }));

        expect(guildReferenceIssues(graph, guild())).toEqual([]);
    });

    it('passes a {{var}} in a picker that takes one — the run resolves it', () => {
        const graph = graphOf(
            node('post', 'action.sendMessage', { channelId: '{{var.ticketChannelId}}', message: 'hi' })
        );

        expect(guildReferenceIssues(graph, guild())).toEqual([]);
    });

    it('leaves an empty pick to the checks that own it', () => {
        const graph = graphOf(node('post', 'action.sendMessage', { channelId: '', message: 'hi' }));

        expect(guildReferenceIssues(graph, guild())).toEqual([]);
    });

    it('does not judge a picker its visibleWhen hides', () => {
        // Wait for Event's channel shows only while it waits on a message.
        const waiting = (eventKind: string) =>
            graphOf(node('wait', 'action.waitForEvent', { eventKind, messageChannelId: 'another-servers-channel' }));

        expect(guildReferenceIssues(waiting('buttonClick'), guild())).toEqual([]);
        // Shown again, it is judged again.
        expect(guildReferenceIssues(waiting('message'), guild())).toHaveLength(1);
    });
});

describe('a picked role', () => {
    it("is refused when it is not one of this server's, on any block", () => {
        const graph = graphOf(node('check', 'condition.hasRole', { roleId: 'another-servers-role' }));

        expect(guildReferenceIssues(graph, guild())).toEqual([
            { nodeId: 'check', field: 'roleId', message: expect.stringMatching(/isn't in this server/) },
        ]);
    });

    it.each([
        ['action.assignRole', 'role-admin', /carries Administrator/],
        ['action.assignRole', 'role-mod', /carries Kick Members, Ban Members/],
        ['action.assignRole', 'role-bot', /belongs to a bot or an integration/],
        ['action.assignRole', GUILD_ID, /@everyone/],
        ['action.removeRole', 'role-admin', /carries Administrator/],
        ['action.removeRole', 'role-mod', /carries Kick Members, Ban Members/],
    ])('is refused on %s when it is %s', (type, roleId, message) => {
        const graph = graphOf(node('change', type, { roleId }));

        expect(guildReferenceIssues(graph, guild())).toEqual([
            { nodeId: 'change', field: 'roleId', message: expect.stringMatching(message) },
        ]);
    });

    it('passes a role a flow may hand out', () => {
        const graph = graphOf(
            node('give', 'action.assignRole', { roleId: PLAIN_ROLE_ID }),
            node('take', 'action.removeRole', { roleId: PLAIN_ROLE_ID })
        );

        expect(guildReferenceIssues(graph, guild())).toEqual([]);
    });

    it('lets a block that only reads roles name a powerful one', () => {
        // Has Role changes nothing, so asking whether someone is an admin is fine.
        const graph = graphOf(node('check', 'condition.hasRole', { roleId: 'role-admin' }));

        expect(guildReferenceIssues(graph, guild())).toEqual([]);
    });
});

describe('readiness in the guild', () => {
    it('reports the guild issues alongside the graph ones', () => {
        const graph = graphOf(node('post', 'action.sendMessage', { channelId: 'another-servers-channel', message: '' }));

        const issues = flowReadinessIssuesInGuild(graph, NEW_FLOW_SCOPE, guild(), { named: new Set(), sizes: new Map() });

        expect(issues.map((issue) => issue.field)).toEqual(['message', 'channelId']);
    });
});
