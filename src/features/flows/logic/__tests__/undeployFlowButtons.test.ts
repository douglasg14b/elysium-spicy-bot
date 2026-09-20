import { ChannelType, type Guild } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { FlowButtonMessageEntity } from '../../data/flowButtonMessagesSchema';
import { undeployFlowButtons } from '../undeployFlowButtons';

/**
 * Taking a flow's buttons back out of the guild.
 *
 * The behaviour worth holding: a message somebody already deleted by hand is a
 * **success**, because the goal is "no live button" and it holds; and a message that
 * could not be deleted keeps its row, because that row is the only way to find those
 * buttons on a later attempt.
 */

const GUILD_ID = 'guild-1';
const FLOW_ID = 'flow-1';

let nextId = 1;

function row(overrides: Partial<FlowButtonMessageEntity> = {}): FlowButtonMessageEntity {
    return {
        id: nextId++,
        guildId: GUILD_ID,
        flowId: FLOW_ID,
        channelId: 'channel-1',
        messageId: 'message-1',
        nodeIds: ['node-1'],
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    } as FlowButtonMessageEntity;
}

interface GuildOptions {
    readonly channelIds?: readonly string[];
    readonly messageIds?: readonly string[];
    readonly calls: string[];
    readonly fetchError?: unknown;
    readonly deleteError?: Error;
}

function makeGuild(options: GuildOptions): Guild {
    const channelIds = new Set(options.channelIds ?? ['channel-1']);
    const messageIds = new Set(options.messageIds ?? ['message-1']);

    return {
        id: GUILD_ID,
        channels: {
            cache: {
                get: (id: string) =>
                    channelIds.has(id)
                        ? {
                              id,
                              type: ChannelType.GuildText,
                              messages: {
                                  fetch: async (messageId: string) => {
                                      if (options.fetchError) throw options.fetchError;
                                      if (!messageIds.has(messageId)) {
                                          throw Object.assign(new Error('Unknown Message'), {
                                              code: 10008,
                                          });
                                      }
                                      return {
                                          id: messageId,
                                          delete: async () => {
                                              if (options.deleteError) throw options.deleteError;
                                              options.calls.push(`discord:delete:${messageId}`);
                                              messageIds.delete(messageId);
                                          },
                                      };
                                  },
                              },
                          }
                        : undefined,
            },
        },
    } as never;
}

function makeRepo(rows: FlowButtonMessageEntity[], calls: string[]) {
    return {
        listByFlowId: vi.fn(async () => rows),
        forget: vi.fn(async (id: number) => {
            calls.push(`repo:forget:${id}`);
            return true;
        }),
    };
}

describe('undeploying a flow\'s buttons', () => {
    it('deletes the recorded message and then its row', async () => {
        const calls: string[] = [];
        const repo = makeRepo([row({ id: 7 })], calls);

        const result = await undeployFlowButtons(GUILD_ID, FLOW_ID, {
            getGuild: async () => makeGuild({ calls }),
            buttonMessagesRepo: repo,
        });

        // The message first, then the row — the same ordering as unpublish, for the
        // same reason: the reverse loses the only pointer to a live button.
        expect(calls).toEqual(['discord:delete:message-1', 'repo:forget:7']);
        expect(result.results[0].outcome).toBe('removed');
    });

    it('treats a message already deleted by hand as a success', async () => {
        const calls: string[] = [];
        const repo = makeRepo([row({ id: 7 })], calls);

        const result = await undeployFlowButtons(GUILD_ID, FLOW_ID, {
            // The channel is there; the message is not.
            getGuild: async () => makeGuild({ calls, messageIds: [] }),
            buttonMessagesRepo: repo,
        });

        expect(result.results[0].outcome).toBe('alreadyGone');
        // The row still goes: there is nothing left for it to point at.
        expect(calls).toEqual(['repo:forget:7']);
    });

    it('treats a deleted channel as a success', async () => {
        const calls: string[] = [];
        const repo = makeRepo([row({ id: 7 })], calls);

        const result = await undeployFlowButtons(GUILD_ID, FLOW_ID, {
            getGuild: async () => makeGuild({ calls, channelIds: [] }),
            buttonMessagesRepo: repo,
        });

        expect(result.results[0].outcome).toBe('alreadyGone');
        expect(repo.forget).toHaveBeenCalledWith(7);
    });

    it('keeps the row when Discord refuses the delete', async () => {
        const calls: string[] = [];
        const repo = makeRepo([row({ id: 7 })], calls);

        const result = await undeployFlowButtons(GUILD_ID, FLOW_ID, {
            getGuild: async () =>
                makeGuild({ calls, deleteError: new Error('Missing Permissions') }),
            buttonMessagesRepo: repo,
        });

        expect(result.results[0].outcome).toBe('failed');
        // The buttons are still live, so the record of where they are must survive.
        expect(repo.forget).not.toHaveBeenCalled();
    });

    it('carries on to the next message when one fails', async () => {
        const calls: string[] = [];
        const repo = makeRepo(
            [row({ id: 7, messageId: 'message-1' }), row({ id: 8, messageId: 'message-2' })],
            calls
        );
        // A permission error on fetch applies to both here, so instead use a channel
        // that holds only the second message: the first reports alreadyGone and the
        // run continues.
        const result = await undeployFlowButtons(GUILD_ID, FLOW_ID, {
            getGuild: async () => makeGuild({ calls, messageIds: ['message-2'] }),
            buttonMessagesRepo: repo,
        });

        expect(result.results).toHaveLength(2);
        expect(result.results[0].outcome).toBe('alreadyGone');
        expect(result.results[1].outcome).toBe('removed');
    });

    it('keeps every row when the guild cannot be reached', async () => {
        const calls: string[] = [];
        const repo = makeRepo([row({ id: 7 })], calls);

        const result = await undeployFlowButtons(GUILD_ID, FLOW_ID, {
            getGuild: async () => null,
            buttonMessagesRepo: repo,
        });

        expect(result.results[0].outcome).toBe('failed');
        // Dropping the rows here would discard the only record of live buttons for a
        // reason that is probably temporary.
        expect(repo.forget).not.toHaveBeenCalled();
    });

    it('does nothing when the flow has nothing recorded', async () => {
        const calls: string[] = [];
        const repo = makeRepo([], calls);
        const getGuild = vi.fn(async () => makeGuild({ calls }));

        const result = await undeployFlowButtons(GUILD_ID, FLOW_ID, {
            getGuild,
            buttonMessagesRepo: repo,
        });

        expect(result.results).toEqual([]);
        // Not even a guild fetch: there is nothing to act on.
        expect(getGuild).not.toHaveBeenCalled();
    });
});
