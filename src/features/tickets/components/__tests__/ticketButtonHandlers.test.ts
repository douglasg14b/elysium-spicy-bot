import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ButtonInteraction } from 'discord.js';
import type { TicketEntity } from '../../data/ticketsSchema';

/**
 * Covers the parts of the button rewrite that a type error would not catch:
 * whether a refusal actually reaches the member, and whether delete writes the
 * row before it destroys the channel.
 *
 * Both were real defects. The handlers call `deferUpdate()` before doing any
 * work, and the registry only auto-replies while an interaction is neither
 * replied nor deferred — so returning `{ status: 'error' }` after that point
 * produced a recorded message that nobody ever saw. The losing side of two
 * moderators racing the claim button is the ordinary case, not an exotic one.
 */

const mockResolveTicketAction = vi.fn();
const mockClaimTicket = vi.fn();
const mockCloseTicket = vi.fn();
const mockDeleteTicket = vi.fn();
const mockSyncTicketChannelToState = vi.fn();

vi.mock('../../logic/resolveTicketAction', () => ({
    resolveTicketAction: (...args: unknown[]) => mockResolveTicketAction(...args),
}));

vi.mock('../../ticketService', () => ({
    claimTicket: (...args: unknown[]) => mockClaimTicket(...args),
    closeTicket: (...args: unknown[]) => mockCloseTicket(...args),
    deleteTicket: (...args: unknown[]) => mockDeleteTicket(...args),
    unclaimTicket: vi.fn(),
    reopenTicket: vi.fn(),
}));

vi.mock('../../logic/ticketChannelOps', () => ({
    syncTicketChannelToState: (...args: unknown[]) => mockSyncTicketChannelToState(...args),
}));

vi.mock('../../logic/ticketPresentation', () => ({
    buildTicketEmbed: () => ({ embed: true }),
    buildTicketButtons: () => [],
}));

import { TicketClaimButtonComponent } from '../ticketClaimButton';
import { TicketCloseButtonComponent } from '../ticketCloseButton';
import { TicketConfirmDeleteButtonComponent } from '../ticketDeleteButton';
import { ok, fail } from '../../../../shared';

function ticket(overrides: Partial<TicketEntity> = {}): TicketEntity {
    return {
        id: 1,
        guildId: 'guild-1',
        ticketNumber: 42,
        type: 'support',
        status: 'open',
        subjectId: 'subject-1',
        openerId: 'opener-1',
        claimerId: null,
        channelId: 'channel-1',
        title: 'A title',
        reason: 'A reason',
        openedAt: new Date('2026-09-17T00:00:00Z'),
        claimedAt: null,
        closedAt: null,
        deletedAt: null,
        updatedAt: new Date('2026-09-17T00:00:00Z'),
        ...overrides,
    } as TicketEntity;
}

interface Harness {
    interaction: ButtonInteraction;
    channelSend: ReturnType<typeof vi.fn>;
    channelDelete: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
    messageEdit: ReturnType<typeof vi.fn>;
}

function harness(): Harness {
    const channelSend = vi.fn().mockResolvedValue(undefined);
    const channelDelete = vi.fn().mockResolvedValue(undefined);
    const followUp = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const messageEdit = vi.fn().mockResolvedValue(undefined);

    const channel = { id: 'channel-1', send: channelSend, delete: channelDelete };

    // `deferred` flips on defer, exactly as discord.js does, so the follow-up
    // path under test is chosen for the same reason it would be in production.
    const interaction = {
        deferred: false,
        replied: false,
        user: { tag: 'mod#0001' },
        message: { edit: messageEdit },
        deferUpdate: vi.fn().mockImplementation(async function (this: { deferred: boolean }) {
            interaction.deferred = true;
        }),
        update: vi.fn().mockImplementation(async () => {
            interaction.replied = true;
        }),
        followUp,
        reply: vi.fn().mockResolvedValue(undefined),
        editReply,
    } as unknown as ButtonInteraction & { deferred: boolean; replied: boolean };

    mockResolveTicketAction.mockResolvedValue(
        ok({
            guild: { id: 'guild-1' },
            member: { id: 'mod-1', toString: () => '<@mod-1>' },
            channel,
            config: { moderationRoles: ['role-1'] },
            ticket: ticket(),
        })
    );

    return { interaction, channelSend, channelDelete, followUp, editReply, messageEdit };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockSyncTicketChannelToState.mockResolvedValue(ok());
});

describe('claim button', () => {
    it('tells the member when the ticket was already claimed by someone else', async () => {
        const { interaction, followUp, channelSend } = harness();
        mockClaimTicket.mockResolvedValue(fail(new Error('Ticket #42 is already claimed by someone else.')));

        const result = await TicketClaimButtonComponent().handler(interaction);

        expect(result.status).toBe('error');
        // The assertion that matters: the refusal was delivered, not merely returned.
        expect(followUp).toHaveBeenCalledWith(
            expect.objectContaining({
                content: '❌ Ticket #42 is already claimed by someone else.',
                ephemeral: true,
            })
        );
        expect(channelSend).not.toHaveBeenCalled();
    });

    it('does not leak an "Error:" prefix from a rejected gate check', async () => {
        const { interaction, followUp } = harness();
        // `fail(string)` wraps the message in an Error despite the declared
        // `string` type, so passing `.error` straight into the reply would
        // render the literal text "Error: ❌ You need…".
        mockResolveTicketAction.mockResolvedValue(fail('❌ You need the **Mod** role to claim tickets.'));

        await TicketClaimButtonComponent().handler(interaction);

        const delivered =
            (interaction.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? followUp.mock.calls[0]?.[0];
        expect(delivered.content).toBe('❌ You need the **Mod** role to claim tickets.');
        expect(delivered.content).not.toContain('Error:');
    });

    it('warns when the channel could not be synced, having already committed the claim', async () => {
        const { interaction, followUp } = harness();
        mockClaimTicket.mockResolvedValue(ok(ticket({ claimerId: 'mod-1' })));
        mockSyncTicketChannelToState.mockResolvedValue(fail(new Error('Missing Permissions')));

        const result = await TicketClaimButtonComponent().handler(interaction);

        expect(result.status).toBe('success');
        expect(followUp).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('could not be moved') })
        );
    });
});

describe('close button', () => {
    it('warns that the subject may still be reading when the permission sync fails', async () => {
        const { interaction, followUp } = harness();
        mockCloseTicket.mockResolvedValue(ok(ticket({ status: 'closed' })));
        mockSyncTicketChannelToState.mockResolvedValue(fail(new Error('Missing Permissions')));

        await TicketCloseButtonComponent().handler(interaction);

        // A silent failure here means moderators discuss someone in a channel
        // that person can still read.
        expect(followUp).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('may still be able to read') })
        );
    });
});

describe('confirm delete button', () => {
    it('marks the row deleted before destroying the channel', async () => {
        const { interaction, channelDelete } = harness();
        const callOrder: string[] = [];
        mockDeleteTicket.mockImplementation(async () => {
            callOrder.push('deleteTicket');
            return ok(ticket({ status: 'deleted', channelId: null }));
        });
        channelDelete.mockImplementation(async () => {
            callOrder.push('channelDelete');
        });

        const result = await TicketConfirmDeleteButtonComponent().handler(interaction);

        expect(result.status).toBe('success');
        // Reversing these leaves a dead channel with a row still pointing at it,
        // and the row is only reachable *through* that channel.
        expect(callOrder).toEqual(['deleteTicket', 'channelDelete']);
    });

    it('never touches the channel when the row update fails', async () => {
        const { interaction, channelDelete, editReply } = harness();
        mockDeleteTicket.mockResolvedValue(fail(new Error('Ticket #42 is already deleted.')));

        const result = await TicketConfirmDeleteButtonComponent().handler(interaction);

        expect(result.status).toBe('error');
        expect(channelDelete).not.toHaveBeenCalled();
        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: '❌ Ticket #42 is already deleted.' })
        );
    });

    it('replaces the "Deleting..." placeholder when the channel cannot be removed', async () => {
        const { interaction, channelDelete, editReply, followUp } = harness();
        mockDeleteTicket.mockResolvedValue(ok(ticket({ status: 'deleted', channelId: null })));
        channelDelete.mockRejectedValue(new Error('Missing Permissions'));

        const result = await TicketConfirmDeleteButtonComponent().handler(interaction);

        expect(result.status).toBe('error');
        // editReply, not followUp: a follow-up would leave "🗑️ Deleting ticket..."
        // standing above the failure notice.
        expect(followUp).not.toHaveBeenCalled();
        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('Delete this channel manually') })
        );
    });
});
