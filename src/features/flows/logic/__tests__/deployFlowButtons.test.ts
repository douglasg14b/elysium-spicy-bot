import { ChannelType, type Guild } from 'discord.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureBlocksDiscovered } from '../../blocks/registry';
import { TRIGGER_BUTTON_CLICK } from '../../blocks/triggerButtonClick';
import { ELIGIBILITY_CONFIG_KEY, OPEN_GATE } from '../../engine/eligibility';
import type { FlowGraph, FlowNode } from '../../data/flowGraph';
import type { FlowEntity } from '../../data/flowsSchema';
import type { FlowsRepo } from '../../data/flowsRepo';
import { deployFlowButtons } from '../deployFlowButtons';
import type { UndeployFlowButtonsResult } from '../undeployFlowButtons';

/**
 * Posting a flow's trigger buttons where its nodes say they go.
 *
 * The behaviour worth holding: a deploy **replaces** rather than accumulates, it
 * retires before it posts so a half-finished attempt leaves nothing live, and a
 * switched-off flow is refused before any of that happens.
 */

const GUILD_ID = 'guild-1';
const FLOW_ID = 'flow-1';

function buttonNode(id: string, data: Record<string, unknown> = {}): FlowNode {
    return {
        id,
        type: TRIGGER_BUTTON_CLICK,
        position: { x: 0, y: 0 },
        data: {
            channelId: 'channel-rules',
            label: 'Agree to rules',
            style: 'Primary',
            [ELIGIBILITY_CONFIG_KEY]: OPEN_GATE,
            ...data,
        },
    } as FlowNode;
}

function flowEntity(nodes: readonly FlowNode[], enabled = true): FlowEntity {
    const graph: FlowGraph = { version: 1, nodes: [...nodes], edges: [] } as FlowGraph;
    return { flowId: FLOW_ID, guildId: GUILD_ID, name: 'Onboarding', enabled, graph } as FlowEntity;
}

function repoFor(flow: FlowEntity): FlowsRepo {
    return { getByFlowId: async () => flow } as unknown as FlowsRepo;
}

interface GuildOptions {
    readonly channelIds?: readonly string[];
    readonly calls: string[];
    /**
     * Channels whose `send` throws, named individually rather than as one flag.
     *
     * A single flag fails the *first* channel every time, which makes the
     * partial-post branch — some channels posted, a later one refused —
     * unreachable from any test. That is the one outcome retire-then-post exists
     * to manage, so it has to be expressible here.
     */
    readonly failChannelIds?: readonly string[];
}

function makeGuild(options: GuildOptions): Guild {
    const channelIds = new Set(options.channelIds ?? ['channel-rules', 'channel-verify']);
    const failing = new Set(options.failChannelIds ?? []);
    let nextMessage = 1;

    const channel = (id: string) =>
        channelIds.has(id)
            ? {
                  id,
                  type: ChannelType.GuildText,
                  send: async () => {
                      if (failing.has(id)) throw new Error('Missing Permissions');
                      options.calls.push(`discord:send:${id}`);
                      return { id: `message-${nextMessage++}` };
                  },
              }
            : undefined;

    return {
        id: GUILD_ID,
        channels: {
            cache: { get: channel },
            // The deployer falls back to a fetch on a cache miss, so an unknown id has
            // to be refused here too — otherwise a "channel is gone" case would
            // resolve on the second try and never reach the refusal it is testing.
            fetch: async (id: string) => channel(id) ?? Promise.reject(new Error('Unknown Channel')),
        },
    } as never;
}

function makeButtonMessagesRepo(calls: string[]) {
    return {
        persist: vi.fn(async (input: { channelId: string; messageId: string }) => {
            calls.push(`repo:persist:${input.channelId}:${input.messageId}`);
            return {} as never;
        }),
    };
}

function undeployStub(calls: string[], results: UndeployFlowButtonsResult['results'] = []) {
    return async (): Promise<UndeployFlowButtonsResult> => {
        calls.push('undeploy');
        return { results };
    };
}

beforeAll(async () => {
    await ensureBlocksDiscovered();
});

describe('posting to each destination', () => {
    it('sends one message per channel and records each one', async () => {
        const calls: string[] = [];
        const buttonMessagesRepo = makeButtonMessagesRepo(calls);

        const result = await deployFlowButtons(GUILD_ID, FLOW_ID, {
            getGuild: async () => makeGuild({ calls }),
            repo: repoFor(
                flowEntity([
                    buttonNode('rules', { channelId: 'channel-rules' }),
                    buttonNode('verify', { channelId: 'channel-verify' }),
                ])
            ),
            buttonMessagesRepo,
            undeploy: undeployStub(calls),
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.posted.map((entry) => entry.channelId)).toEqual([
            'channel-rules',
            'channel-verify',
        ]);
        expect(result.buttonCount).toBe(2);
        // One row per message, each naming the channel it actually went to — the
        // record `undeployFlowButtons` later reads to find these buttons again.
        expect(calls).toEqual([
            'undeploy',
            'discord:send:channel-rules',
            'repo:persist:channel-rules:message-1',
            'discord:send:channel-verify',
            'repo:persist:channel-verify:message-2',
        ]);
    });

    it('refuses before posting anything when a destination is not a text channel', async () => {
        const calls: string[] = [];

        const result = await deployFlowButtons(GUILD_ID, FLOW_ID, {
            getGuild: async () => makeGuild({ calls, channelIds: ['channel-rules'] }),
            repo: repoFor(
                flowEntity([
                    buttonNode('rules', { channelId: 'channel-rules' }),
                    buttonNode('verify', { channelId: 'channel-gone' }),
                ])
            ),
            buttonMessagesRepo: makeButtonMessagesRepo(calls),
            undeploy: undeployStub(calls),
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.message).toMatch(/channel-gone/);
        // Nothing posted and nothing retired: resolving up front is what keeps a bad
        // channel from leaving the good half of a flow live.
        expect(calls).toEqual([]);
    });
});

describe('redeploying', () => {
    it('retires the existing buttons before posting fresh ones', async () => {
        const calls: string[] = [];

        const result = await deployFlowButtons(GUILD_ID, FLOW_ID, {
            getGuild: async () => makeGuild({ calls }),
            repo: repoFor(flowEntity([buttonNode('rules')])),
            buttonMessagesRepo: makeButtonMessagesRepo(calls),
            undeploy: undeployStub(calls, [
                { channelId: 'channel-rules', messageId: 'old-1', outcome: 'removed' },
            ]),
        });

        expect(result.ok).toBe(true);
        /*
         * Asserted as a whole sequence rather than as "undeploy comes before send".
         * That comparison passes when the retire never happens at all — `indexOf`
         * returns -1, which is less than everything — so it could not fail for the
         * reason it exists. Order is the whole guard: posting first would orphan the
         * old message when the retire then failed, and `flow_button_messages` is
         * insert-only, so without the retire a second deploy simply adds a second
         * live message.
         */
        expect(calls).toEqual([
            'undeploy',
            'discord:send:channel-rules',
            'repo:persist:channel-rules:message-1',
        ]);
    });

    it('posts nothing when the old buttons could not be cleared', async () => {
        const calls: string[] = [];

        const result = await deployFlowButtons(GUILD_ID, FLOW_ID, {
            getGuild: async () => makeGuild({ calls }),
            repo: repoFor(flowEntity([buttonNode('rules')])),
            buttonMessagesRepo: makeButtonMessagesRepo(calls),
            undeploy: undeployStub(calls, [
                {
                    channelId: 'channel-rules',
                    messageId: 'old-1',
                    outcome: 'failed',
                    explanation: 'Missing Permissions',
                },
            ]),
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.message).toMatch(/Missing Permissions/);
        // Says plainly that the old set is still live, so a retry is understood to
        // start from what is already there rather than from nothing.
        expect(result.message).toMatch(/still live/);
        expect(calls).toEqual(['undeploy']);
    });

    it('says the old buttons are already gone when the post then fails', async () => {
        // The cost of retiring first, and the operator has to be told about it:
        // otherwise they cannot tell whether they are half-deployed or clean.
        const calls: string[] = [];

        const result = await deployFlowButtons(GUILD_ID, FLOW_ID, {
            getGuild: async () => makeGuild({ calls, failChannelIds: ['channel-rules'] }),
            repo: repoFor(flowEntity([buttonNode('rules')])),
            buttonMessagesRepo: makeButtonMessagesRepo(calls),
            undeploy: undeployStub(calls, [
                { channelId: 'channel-rules', messageId: 'old-1', outcome: 'removed' },
            ]),
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.message).toMatch(/already taken down/);
        expect(result.message).toMatch(/nothing of it is live/);
    });

    it('does not claim nothing is live when earlier channels were already posted', async () => {
        /*
         * The half-live state, and the one the operator most needs told straight.
         *
         * The retire succeeded and the first channel posted, so "nothing of it is
         * live right now" is false — a message carrying real buttons is sitting in
         * `#rules`. Saying both at once gives an operator two adjacent sentences
         * asserting opposite facts, and the one they would act on is the wrong one.
         */
        const calls: string[] = [];

        const result = await deployFlowButtons(GUILD_ID, FLOW_ID, {
            getGuild: async () => makeGuild({ calls, failChannelIds: ['channel-verify'] }),
            repo: repoFor(
                flowEntity([
                    buttonNode('rules', { channelId: 'channel-rules' }),
                    buttonNode('verify', { channelId: 'channel-verify' }),
                ])
            ),
            buttonMessagesRepo: makeButtonMessagesRepo(calls),
            undeploy: undeployStub(calls, [
                { channelId: 'channel-rules', messageId: 'old-1', outcome: 'removed' },
            ]),
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(calls).toContain('discord:send:channel-rules');
        expect(result.message).not.toMatch(/nothing of it is live/);
        expect(result.message).toMatch(/already went out and are live/);
        // Deploying again is what cleans this up, and the message has to say so —
        // the retire on the next attempt is what removes the half that did post.
        expect(result.message).toMatch(/replace them/);
    });
});

describe('a switched-off flow', () => {
    it('is refused rather than deployed', async () => {
        // Every press of a disabled flow's button answers "This flow is currently
        // disabled", so deploying one posts guaranteed-dead buttons in public.
        const calls: string[] = [];

        const result = await deployFlowButtons(GUILD_ID, FLOW_ID, {
            getGuild: async () => makeGuild({ calls }),
            repo: repoFor(flowEntity([buttonNode('rules')], false)),
            buttonMessagesRepo: makeButtonMessagesRepo(calls),
            undeploy: undeployStub(calls),
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.message).toMatch(/switched off/);
        // Refused before the retire, so asking to deploy a disabled flow cannot take
        // down the buttons it already has.
        expect(calls).toEqual([]);
    });
});
