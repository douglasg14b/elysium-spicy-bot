import { beforeEach, describe, expect, it, vi } from 'vitest';

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
 */

const closeTicket = vi.fn();
const getTicket = vi.fn();
const applyTicketTransition = vi.fn();
const ticketingRepoGet = vi.fn();

vi.mock('../../../../tickets', () => ({ closeTicket, getTicket }));
vi.mock('../../../../tickets/logic/applyTicketTransition', () => ({ applyTicketTransition }));
vi.mock('../../../../tickets/data/ticketingRepo', () => ({ ticketingRepo: { get: ticketingRepoGet } }));

const { block } = await import('../index');

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

function context(chainDepth = 1) {
    return {
        guild: { id: 'guild-1', client: { user: { id: 'bot-1' } } },
        client: { user: { id: 'bot-1' } },
        chainDepth,
    } as never;
}

/** What a flow's close says about itself: the bot acted, at the run's own depth. */
const FLOW_CHANGE = { actorId: 'bot-1', chainDepth: 1 };

beforeEach(() => {
    vi.clearAllMocks();
    getTicket.mockResolvedValue(ticket);
    ticketingRepoGet.mockResolvedValue({ id: 1, guildId: 'guild-1', config: CONFIGURED, ticketNumberInc: 42, entityVersion: 1 });
    applyTicketTransition.mockResolvedValue({ ok: true, outcome: { ticket: { ...ticket, status: 'closed' }, syncWarning: null } });
    closeTicket.mockResolvedValue({ ok: true, value: { ...ticket, status: 'closed' } });
});

describe('action.closeTicket', () => {
    it('closes through the shared orchestration, so the channel moves like a button press would', async () => {
        const result = await block.run({ ticketId: '7' }, context());

        expect(result).toEqual({ kind: 'continue' });
        expect(applyTicketTransition).toHaveBeenCalledWith(
            expect.objectContaining({ transition: 'close', ticket })
        );
        // Not the bare service call: that would be the fifth copy again, and the channel
        // would stay in whichever category it was in.
        expect(closeTicket).not.toHaveBeenCalled();
    });

    it('names the actor as automation rather than leaving the announcement blank', async () => {
        await block.run({ ticketId: '7' }, context());

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
        await block.run({ ticketId: '7' }, context(3));

        expect(applyTicketTransition).toHaveBeenCalledWith(
            expect.objectContaining({ change: { actorId: 'bot-1', chainDepth: 3 } })
        );
    });

    it('still closes the row when the guild has no usable ticket config', async () => {
        // The old behaviour, preserved on purpose. A flow must not be blocked from
        // closing a ticket because the guild's *presentation* config has rotted — what
        // is lost is the channel move, which the old code lost too.
        ticketingRepoGet.mockResolvedValue(null);

        const result = await block.run({ ticketId: '7' }, context());

        expect(result).toEqual({ kind: 'continue' });
        expect(closeTicket).toHaveBeenCalledWith(7, FLOW_CHANGE);
        expect(applyTicketTransition).not.toHaveBeenCalled();
    });

    it('still closes the row when the ticket holds a type the guild no longer declares', async () => {
        // Same reasoning: there is no permission model to sync the channel with, but the
        // lifecycle decision is the service's and it is still valid.
        getTicket.mockResolvedValue({ ...ticket, type: 'retired' });

        const result = await block.run({ ticketId: '7' }, context());

        expect(result).toEqual({ kind: 'continue' });
        expect(closeTicket).toHaveBeenCalledWith(7, FLOW_CHANGE);
        expect(applyTicketTransition).not.toHaveBeenCalled();
    });

    it('throws the orchestration’s refusal rather than continuing as if it closed', async () => {
        // The block's contract is that the ticket is closed when the run continues. A
        // swallowed refusal would let the flow proceed on a ticket that is still open.
        applyTicketTransition.mockResolvedValue({ ok: false, message: 'Ticket #42 is already closed.' });

        await expect(block.run({ ticketId: '7' }, context())).rejects.toThrow('already closed');
    });

    it('rejects a token that resolved to nothing rather than closing ticket 0', async () => {
        // `Number('')` is 0, which passes an isInteger guard and then fails deep in the
        // service as "no ticket 0", blaming an id the flow author never wrote.
        await expect(block.run({ ticketId: '' }, context())).rejects.toThrow('needs a ticket id');
        expect(getTicket).not.toHaveBeenCalled();
    });

    it('rejects a ticket id that names no ticket', async () => {
        getTicket.mockResolvedValue(null);

        await expect(block.run({ ticketId: '999' }, context())).rejects.toThrow('999');
    });
});
