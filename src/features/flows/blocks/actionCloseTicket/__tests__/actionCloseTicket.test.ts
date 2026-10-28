import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectiveRequirements } from '../../../engine/nodeRequirements';
import { parseNodeConfig, type BlockManifest } from '../../manifest';

/**
 * The `action.closeTicket` block's run path.
 *
 * Written because this block was the fifth copy of commit-then-sync-then-warn and was
 * rewritten to call `applyTicketTransition` instead — and it had **no behavioural test
 * at all** before that, only block discovery. A production path with no coverage being
 * refactored is exactly where a silent regression lands.
 *
 * Two properties matter and neither is obvious from reading the block:
 *
 *  1. It goes through the shared orchestration when it can, so a flow-driven close moves
 *     the channel and re-renders the embed the same way a button press does.
 *  2. It **still closes the row** when the guild's ticket config is unusable. The record
 *     is the truth and the channel is one of its renderings, so a flow must not be
 *     blocked from closing a ticket because the guild's presentation config has rotted.
 *     That was the old behaviour and losing it would be a regression nothing else would
 *     notice.
 *
 * And a third, from the "which ticket" choice: the ticket in the run's channel is found by
 * that channel, in this guild only, and a node saved before the choice still closes by id.
 */

const closeTicket = vi.fn();
const getTicket = vi.fn();
const getTicketByChannel = vi.fn();
const applyTicketTransition = vi.fn();
const ticketingRepoGet = vi.fn();

vi.mock('../../../../tickets', () => ({ closeTicket, getTicket, getTicketByChannel }));
vi.mock('../../../../tickets/logic/applyTicketTransition', () => ({ applyTicketTransition }));
vi.mock('../../../../tickets/data/ticketingRepo', () => ({ ticketingRepo: { get: ticketingRepoGet } }));

const { block } = await import('../index');

/** The block as the registry holds it, config type erased — to run raw node data parsed as the executor parses it. */
const registered: BlockManifest = block;

/** Run the block on raw node data, parsed exactly as the executor parses it. */
async function runOn(data: Record<string, unknown>, runContext: never) {
    const parsed = parseNodeConfig(registered, data);
    if (!parsed.success) throw new Error(`refused ${JSON.stringify(data)}: ${parsed.error.message}`);
    return registered.run(parsed.data, runContext);
}

const CONFIGURED = {
    modTicketsDeployed: true,
    modTicketsDeployedChannelId: 'panel-channel',
    modTicketsDeployedMessageId: 'panel-message',
    categories: {
        open: { name: 'Tickets', discordId: '900000000000000001', provenance: 'adopted' },
        claimed: { name: 'Claimed', discordId: '900000000000000002', provenance: 'adopted' },
        closed: { name: 'Closed', discordId: '900000000000000003', provenance: 'adopted' },
    },
    moderationRoles: ['mod-role'],
    ticketTypes: {
        support: {
            type: 'support',
            label: 'Support',
            nameTemplate: 'S{{####}}-{{subject}}',
            permissions: {
                subject: { view: true, send: true, readHistory: true, manageMessages: false },
                opener: { view: true, send: true, readHistory: true, manageMessages: false },
                staff: { view: true, send: true, readHistory: true, manageMessages: true },
            },
            autoClaimOnOpen: true,
        },
    },
};

const ticket = { id: 7, guildId: 'guild-1', ticketNumber: 42, type: 'support', status: 'open', channelId: 'channel-1' };

/** The run's channel: a plain channel, or a thread sitting under `parentId`. */
function runChannel(channelId: string, parentId?: string) {
    return { id: channelId, parentId: parentId ?? null, isThread: () => parentId !== undefined };
}

function context(chainDepth = 1, channelId: string | null = 'channel-1', parentId?: string) {
    return {
        guild: { id: 'guild-1', client: { user: { id: 'bot-1' } } },
        client: { user: { id: 'bot-1' } },
        ...(channelId === null ? {} : { channel: runChannel(channelId, parentId) }),
        chainDepth,
    } as never;
}

/** A node closing ticket `ticketId` by id — the default, as every node saved before the choice. */
const byId = (ticketId: string) => ({ source: 'id' as const, ticketId });

/** A node closing whichever ticket the run's channel is. */
const HERE = { source: 'here' as const };

/** What a flow's close says about itself: the bot acted, at the run's own depth. */
const FLOW_CHANGE = { actorId: 'bot-1', chainDepth: 1 };

beforeEach(() => {
    vi.clearAllMocks();
    getTicket.mockResolvedValue(ticket);
    getTicketByChannel.mockResolvedValue(ticket);
    ticketingRepoGet.mockResolvedValue({ id: 1, guildId: 'guild-1', config: CONFIGURED, ticketNumberInc: 42, entityVersion: 1 });
    applyTicketTransition.mockResolvedValue({ ok: true, outcome: { ticket: { ...ticket, status: 'closed' }, syncWarning: null } });
    closeTicket.mockResolvedValue({ ok: true, value: { ...ticket, status: 'closed' } });
});

describe('action.closeTicket', () => {
    it('closes through the shared orchestration, so the channel moves like a button press would', async () => {
        const result = await block.run(byId('7'), context());

        expect(result).toEqual({ kind: 'continue' });
        expect(applyTicketTransition).toHaveBeenCalledWith(
            expect.objectContaining({ transition: 'close', ticket })
        );
        // Not the bare service call: that would be the fifth copy again, and the channel
        // would stay in whichever category it was in.
        expect(closeTicket).not.toHaveBeenCalled();
    });

    it('names the actor as automation rather than leaving the announcement blank', async () => {
        await block.run(byId('7'), context());

        const actor = applyTicketTransition.mock.calls[0][0].actor as { mention: string };
        // Asserted literally, not with `toBeTruthy()`: `mention` is a required non-optional
        // string, so a truthiness check passes on anything at all and proves nothing.
        expect(actor.mention).toBe('an automated flow');
        // No raw mention: the announcement goes into the ticket channel, and a `<@id>`
        // there would ping somebody every time a flow closed a ticket.
        expect(actor.mention).not.toContain('<@');
    });

    it('says nobody made the change, at the run’s own depth, though it names the bot in the channel', async () => {
        // The announcement names the bot; the change it reports to subscribers must not,
        // or a Ticket Event flow would see the bot as a person who acted.
        await block.run(byId('7'), context(3));

        expect(applyTicketTransition).toHaveBeenCalledWith(
            expect.objectContaining({ change: { actorId: 'bot-1', chainDepth: 3 } })
        );
    });

    it('still closes the row when the guild has no usable ticket config', async () => {
        // The old behaviour, preserved on purpose. A flow must not be blocked from
        // closing a ticket because the guild's *presentation* config has rotted — what
        // is lost is the channel move, which the old code lost too.
        ticketingRepoGet.mockResolvedValue(null);

        const result = await block.run(byId('7'), context());

        expect(result).toEqual({ kind: 'continue' });
        expect(closeTicket).toHaveBeenCalledWith(7, FLOW_CHANGE);
        expect(applyTicketTransition).not.toHaveBeenCalled();
    });

    it('still closes the row when the ticket holds a type the guild no longer declares', async () => {
        // Same reasoning: there is no permission model to sync the channel with, but the
        // lifecycle decision is the service's and it is still valid.
        getTicket.mockResolvedValue({ ...ticket, type: 'retired' });

        const result = await block.run(byId('7'), context());

        expect(result).toEqual({ kind: 'continue' });
        expect(closeTicket).toHaveBeenCalledWith(7, FLOW_CHANGE);
        expect(applyTicketTransition).not.toHaveBeenCalled();
    });

    it('throws the orchestration’s refusal rather than continuing as if it closed', async () => {
        // The block's contract is that the ticket is closed when the run continues. A
        // swallowed refusal would let the flow proceed on a ticket that is still open.
        applyTicketTransition.mockResolvedValue({ ok: false, message: 'Ticket #42 is already closed.' });

        await expect(block.run(byId('7'), context())).rejects.toThrow('already closed');
    });

    it('rejects a token that resolved to nothing rather than closing ticket 0', async () => {
        // `Number('')` is 0, which passes an isInteger guard and then fails deep in the
        // service as "no ticket 0", blaming an id the flow author never wrote.
        await expect(block.run(byId(''), context())).rejects.toThrow('needs a ticket id');
        expect(getTicket).not.toHaveBeenCalled();
    });

    it('rejects a ticket id that names no ticket', async () => {
        getTicket.mockResolvedValue(null);

        await expect(block.run(byId('999'), context())).rejects.toThrow('999');
    });

    it("rejects another server's ticket by id, though the id exists", async () => {
        getTicket.mockResolvedValue({ ...ticket, guildId: 'guild-2' });

        await expect(block.run(byId('7'), context())).rejects.toThrow('found no ticket with id 7 in this server');
        expect(applyTicketTransition).not.toHaveBeenCalled();
        expect(closeTicket).not.toHaveBeenCalled();
    });
});

describe('action.closeTicket on the ticket in this channel', () => {
    it("closes the ticket whose channel the run happened in, found by the run's channel", async () => {
        const result = await block.run(HERE, context(1, 'channel-1'));

        expect(result).toEqual({ kind: 'continue' });
        expect(getTicketByChannel).toHaveBeenCalledWith('channel-1');
        expect(getTicket).not.toHaveBeenCalled();
        expect(applyTicketTransition).toHaveBeenCalledWith(expect.objectContaining({ transition: 'close', ticket }));
    });

    it('closes the ticket a thread sits in, found by the channel the thread is under', async () => {
        const result = await block.run(HERE, context(1, 'thread-1', 'channel-1'));

        expect(result).toEqual({ kind: 'continue' });
        expect(getTicketByChannel).toHaveBeenCalledWith('channel-1');
        expect(applyTicketTransition).toHaveBeenCalledWith(expect.objectContaining({ transition: 'close', ticket }));
    });

    it("fails by name in a channel that is no ticket's, and closes nothing", async () => {
        getTicketByChannel.mockResolvedValue(null);

        await expect(block.run(HERE, context(1, 'general'))).rejects.toThrow(
            "Close Ticket went looking for a ticket in this channel (general) and came up empty — this isn't a ticket channel."
        );
        expect(applyTicketTransition).not.toHaveBeenCalled();
        expect(closeTicket).not.toHaveBeenCalled();
    });

    it("does not find another server's ticket by a channel id that matches", async () => {
        getTicketByChannel.mockResolvedValue({ ...ticket, guildId: 'guild-2' });

        await expect(block.run(HERE, context(1, 'channel-1'))).rejects.toThrow("this isn't a ticket channel");
        expect(applyTicketTransition).not.toHaveBeenCalled();
        expect(closeTicket).not.toHaveBeenCalled();
    });

    it('fails by name when the run has no channel — deleted while it waited, or never resolved', async () => {
        await expect(block.run(HERE, context(1, null))).rejects.toThrow(
            "set to close the ticket in this channel, and this run isn't in a channel the bot can reach"
        );
        expect(getTicketByChannel).not.toHaveBeenCalled();
    });

    it('ignores an id the node still holds from before the switch', async () => {
        // Hidden means absent: the executor parses the node without the hidden id, so the
        // channel decides.
        await runOn({ source: 'here', ticketId: '999' }, context(1, 'channel-1'));

        expect(getTicketByChannel).toHaveBeenCalledWith('channel-1');
        expect(getTicket).not.toHaveBeenCalled();
    });
});

describe('action.closeTicket config, as the executor parses it', () => {
    it('reads a node saved before the choice as closing by id', async () => {
        const parsed = parseNodeConfig(registered, { ticketId: '7' });
        expect(parsed.data).toEqual({ source: 'id', ticketId: '7' });

        // No channel on the run either: closing by id never needed one.
        expect(await runOn({ ticketId: '7' }, context(1, null))).toEqual({ kind: 'continue' });
        expect(getTicket).toHaveBeenCalledWith(7);
        expect(getTicketByChannel).not.toHaveBeenCalled();
    });

    it('asks for an id only while closing by one', () => {
        const byIdWithout = parseNodeConfig(registered, {});
        expect(byIdWithout.success).toBe(false);
        expect(byIdWithout.error?.issues).toEqual([
            expect.objectContaining({ path: ['ticketId'], message: 'Which ticket? Give it an id — or close the ticket in this channel.' }),
        ]);

        expect(parseNodeConfig(registered, { source: 'here' }).success).toBe(true);
    });

    it("needs the run's channel only for the ticket in this channel", () => {
        const needs = (data: Record<string, unknown>) => effectiveRequirements(block, data).map(({ requirement }) => requirement);

        expect(needs({ ticketId: '7' })).toEqual([]);
        expect(needs({ source: 'id', ticketId: '7' })).toEqual([]);
        expect(needs({ source: 'here' })).toEqual(['channel']);
    });
});
