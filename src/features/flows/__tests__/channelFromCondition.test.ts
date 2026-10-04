import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../data/flowGraph';
import { ensureBlocksDiscovered } from '../blocks/registry';
import type { FlowRunSeed } from '../blocks/types';
import { executeFlow } from '../engine/executor';
import { validateAuthoredGraph } from '../engine/graphValidation';

/**
 * A channel an earlier block found, picked in a later block's channel picker.
 *
 * Driven through the real executor and the real blocks: `condition.hasOpenTicket`
 * records the ticket's channel on Yes, and `action.sendMessage` posts there because
 * its picker holds `{{var.ticketChannelId}}`. Only the ticket lookup is faked.
 */

const mockFindOpenTicket = vi.fn();

vi.mock('../../tickets', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../tickets')>();
    return { ...actual, findOpenTicket: (...args: unknown[]) => mockFindOpenTicket(...args) };
});

beforeAll(ensureBlocksDiscovered);

beforeEach(() => {
    mockFindOpenTicket.mockReset();
});

/** A client whose every channel is sendable, recording what landed where. */
function makeSeed(): { context: FlowRunSeed; sentTo: Map<string, string[]> } {
    const sentTo = new Map<string, string[]>();
    const fetch = vi.fn(async (channelId: string) => ({
        isTextBased: () => true,
        send: vi.fn(async ({ content }: { content: string }) => {
            sentTo.set(channelId, [...(sentTo.get(channelId) ?? []), content]);
            return { id: 'message-1' };
        }),
    }));

    return {
        sentTo,
        context: {
            client: { channels: { fetch } } as unknown as FlowRunSeed['client'],
            guild: { id: 'guild-1', name: 'Afterdark' } as FlowRunSeed['guild'],
            subject: { id: 'user-1', toString: () => '<@user-1>', user: { username: 'spicypete' } } as unknown as FlowRunSeed['subject'],
            variables: {},
        },
    };
}

/** `trigger -> Has Open Ticket? -(yes)-> post in {{var.ticketChannelId}}`, plus whatever No does. */
function graph(options: { noBranchChannel?: string; triggerChannel?: string } = {}): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            {
                id: 'trigger',
                type: 'trigger.buttonClick',
                position: { x: 0, y: 0 },
                data: { channelId: options.triggerChannel ?? 'lobby', label: 'Go' },
            },
            // A type the guild declared itself: the seeded two are never special.
            { id: 'check', type: 'condition.hasOpenTicket', position: { x: 1, y: 0 }, data: { ticketType: 'punishment-review' } },
            {
                id: 'yes',
                type: 'action.sendMessage',
                position: { x: 2, y: 0 },
                data: { channelId: '{{var.ticketChannelId}}', message: 'Back again, {{subject.mention}}?' },
            },
            ...(options.noBranchChannel
                ? [
                      {
                          id: 'no',
                          type: 'action.sendMessage',
                          position: { x: 2, y: 1 },
                          data: { channelId: options.noBranchChannel, message: 'Nothing open.' },
                      },
                  ]
                : []),
        ],
        edges: [
            { id: 'e1', source: 'trigger', target: 'check' },
            { id: 'e2', source: 'check', sourceHandle: 'true', target: 'yes' },
            ...(options.noBranchChannel ? [{ id: 'e3', source: 'check', sourceHandle: 'false', target: 'no' }] : []),
        ],
    } as FlowGraph;
}

describe('a channel picked from what an earlier block found', () => {
    it('posts in the open ticket’s channel', async () => {
        mockFindOpenTicket.mockResolvedValue({ id: 7, channelId: 'ticket-channel-7' });
        const { context, sentTo } = makeSeed();

        const result = await executeFlow('flow-1', graph(), 'trigger', context);

        expect(result.status).toBe('success');
        expect(sentTo.get('ticket-channel-7')).toEqual(['Back again, <@user-1>?']);
        expect(mockFindOpenTicket).toHaveBeenCalledWith('guild-1', 'user-1', 'punishment-review');
    });

    it('takes the No branch, recording nothing, when there is no open ticket', async () => {
        mockFindOpenTicket.mockResolvedValue(null);
        const { context, sentTo } = makeSeed();

        const result = await executeFlow('flow-1', graph({ noBranchChannel: 'lobby' }), 'trigger', context);

        expect(result.status).toBe('success');
        expect([...sentTo.keys()]).toEqual(['lobby']);
    });

    it('fails naming the variable when the open ticket has lost its channel', async () => {
        // Still a Yes — the ticket is a record, and it is open — but there is
        // nowhere to post. Without the check the block asks Discord for channel ''.
        mockFindOpenTicket.mockResolvedValue({ id: 7, channelId: null });
        const { context, sentTo } = makeSeed();

        const result = await executeFlow('flow-1', graph(), 'trigger', context);

        expect(result.status).toBe('error');
        expect(result.error).toContain('{{var.ticketChannelId}}');
        expect(result.error).toContain('"Channel"');
        // The ticket is gone, not the wiring: the message must not send the
        // author off to rewire a graph that is fine.
        expect(result.error).toContain('recorded empty');
        expect(sentTo.size).toBe(0);
    });
});

describe('saving a picker whose variable is the wrong kind', () => {
    it('refuses a ticket number in a channel picker, though a block does record it', () => {
        const wrongKind = graph();
        const yes = wrongKind.nodes.find((candidate) => candidate.id === 'yes');
        if (yes) yes.data = { ...yes.data, channelId: '{{var.ticketId}}' };

        const result = validateAuthoredGraph(wrongKind);

        expect(result.valid ? [] : result.errors).toEqual([
            expect.stringContaining('no block in this flow records a channel by that name'),
        ]);
    });
});

describe('saving a picker that holds a variable', () => {
    it('accepts one {{var.name}} in an action’s channel picker', () => {
        expect(validateAuthoredGraph(graph())).toEqual({ valid: true, graph: graph() });
    });

    it('refuses anything around the token, because that is not a channel', () => {
        const withPrefix = graph();
        const yes = withPrefix.nodes.find((candidate) => candidate.id === 'yes');
        if (yes) yes.data = { ...yes.data, channelId: '#{{var.ticketChannelId}}' };

        const result = validateAuthoredGraph(withPrefix);

        expect(result.valid).toBe(false);
        expect(result.valid ? [] : result.errors).toEqual([expect.stringContaining('A picker takes a choice')]);
    });

    it('refuses a token in a trigger’s picker, which its dispatcher reads before any run exists', () => {
        const result = validateAuthoredGraph(graph({ triggerChannel: '{{var.ticketChannelId}}' }));

        expect(result.valid).toBe(false);
        expect(result.valid ? [] : result.errors).toEqual([expect.stringContaining('A trigger has nothing before it')]);
    });
});
