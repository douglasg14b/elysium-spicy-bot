import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketEntity } from '../data/ticketsSchema';

const mockCreate = vi.fn();
const mockGetById = vi.fn();
const mockUpdate = vi.fn();
const mockFindOpenBySubject = vi.fn();
const mockIncrementTicketNumber = vi.fn();
const mockClaimIfUnclaimed = vi.fn();
const mockTransitionStatus = vi.fn();

vi.mock('../data/ticketsRepo', () => ({
    ticketsRepo: {
        create: (...args: unknown[]) => mockCreate(...args),
        getById: (...args: unknown[]) => mockGetById(...args),
        update: (...args: unknown[]) => mockUpdate(...args),
        findOpenBySubject: (...args: unknown[]) => mockFindOpenBySubject(...args),
        claimIfUnclaimed: (...args: unknown[]) => mockClaimIfUnclaimed(...args),
        transitionStatus: (...args: unknown[]) => mockTransitionStatus(...args),
    },
}));

vi.mock('../data/ticketingRepo', () => ({
    ticketingRepo: {
        incrementTicketNumber: (...args: unknown[]) => mockIncrementTicketNumber(...args),
    },
}));

import {
    claimTicket,
    closeTicket,
    deleteTicket,
    hasOpenTicket,
    openTicket,
    reopenTicket,
    unclaimTicket,
} from '../ticketService';

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

beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockImplementation(async (values: Record<string, unknown>) => ticket(values as Partial<TicketEntity>));
    mockUpdate.mockImplementation(async (id: number, changes: Record<string, unknown>) =>
        ticket({ id, ...(changes as Partial<TicketEntity>) })
    );
    mockIncrementTicketNumber.mockResolvedValue(7);
    mockClaimIfUnclaimed.mockImplementation(async (id: number, claimerId: string, claimedAt: string) =>
        ticket({ id, claimerId, claimedAt: new Date(claimedAt) })
    );
    mockTransitionStatus.mockImplementation(async (id: number, _from: string, changes: Record<string, unknown>) =>
        ticket({ id, ...(changes as Partial<TicketEntity>) })
    );
});

describe('openTicket', () => {
    it('allocates the ticket number atomically before any channel exists', async () => {
        const result = await openTicket({
            guildId: 'guild-1',
            type: 'support',
            subjectId: 'subject-1',
            openerId: 'opener-1',
            title: 'Title',
            reason: 'Reason',
        });

        expect(result.ok).toBe(true);
        expect(mockIncrementTicketNumber).toHaveBeenCalledWith('guild-1');
        expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ ticketNumber: 7, channelId: null }));
    });

    it('auto-claims a support ticket to its opener', async () => {
        await openTicket({
            guildId: 'guild-1',
            type: 'support',
            subjectId: 'subject-1',
            openerId: 'opener-1',
            title: 'Title',
            reason: 'Reason',
        });

        expect(mockCreate).toHaveBeenCalledWith(
            expect.objectContaining({ claimerId: 'opener-1', claimedAt: expect.any(String) })
        );
    });

    it('opens a verification ticket unclaimed and with no opener', async () => {
        // The case the old creation path could not express at all: it took the
        // opener from `interaction.user` and always auto-claimed.
        await openTicket({
            guildId: 'guild-1',
            type: 'verification',
            subjectId: 'subject-1',
            openerId: null,
            title: 'Verify',
            reason: 'Flow opened',
        });

        expect(mockCreate).toHaveBeenCalledWith(
            expect.objectContaining({ openerId: null, claimerId: null, claimedAt: null, status: 'open' })
        );
    });

    it('does not create a record when the number cannot be allocated', async () => {
        mockIncrementTicketNumber.mockRejectedValue(new Error('no config'));

        const result = await openTicket({
            guildId: 'guild-1',
            type: 'support',
            subjectId: 'subject-1',
            openerId: 'opener-1',
            title: 'Title',
            reason: 'Reason',
        });

        expect(result.ok).toBe(false);
        expect(mockCreate).not.toHaveBeenCalled();
    });
});

describe('claim and unclaim are independent of lifecycle', () => {
    it('claims an open, unclaimed ticket', async () => {
        mockGetById.mockResolvedValue(ticket({ claimerId: null }));

        const result = await claimTicket(1, 'mod-1');

        expect(result.ok).toBe(true);
        // A conditional UPDATE, not a read-then-write: the `where` clause is
        // what decides, so a second claimer racing the first gets nothing back.
        expect(mockClaimIfUnclaimed).toHaveBeenCalledWith(1, 'mod-1', expect.any(String));
    });

    it('reports a loss to a racing claimer instead of overwriting them', async () => {
        mockGetById.mockResolvedValue(ticket({ claimerId: null }));
        // Zero rows back is how the database says "someone got here first".
        mockClaimIfUnclaimed.mockResolvedValue(null);

        const result = await claimTicket(1, 'mod-1');

        expect(result.ok).toBe(false);
    });

    it('refuses to claim a ticket someone else holds', async () => {
        mockGetById.mockResolvedValue(ticket({ claimerId: 'mod-other' }));

        const result = await claimTicket(1, 'mod-1');

        expect(result.ok).toBe(false);
        expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('refuses to claim a closed ticket', async () => {
        mockGetById.mockResolvedValue(ticket({ status: 'closed', claimerId: null }));

        expect((await claimTicket(1, 'mod-1')).ok).toBe(false);
    });

    it('unclaims without changing the lifecycle status', async () => {
        // The transition the old three-value enum could not represent: unclaiming
        // meant moving back to `active`, which conflated ownership with lifecycle.
        mockGetById.mockResolvedValue(ticket({ claimerId: 'mod-1' }));

        const result = await unclaimTicket(1);

        expect(result.ok).toBe(true);
        expect(mockUpdate).toHaveBeenCalledWith(1, { claimerId: null, claimedAt: null });
        expect(mockUpdate.mock.calls[0][1]).not.toHaveProperty('status');
    });
});

describe('close, reopen and delete', () => {
    it('closes an open ticket and keeps the claimer as a record of who handled it', async () => {
        mockGetById.mockResolvedValue(ticket({ claimerId: 'mod-1' }));

        const result = await closeTicket(1);

        expect(result.ok).toBe(true);
        // Guarded on `open`, so a close racing a delete cannot land on top of it
        // and leave a row that is `closed` while carrying `deletedAt`.
        expect(mockTransitionStatus).toHaveBeenCalledWith(1, 'open', {
            status: 'closed',
            closedAt: expect.any(String),
        });
        expect(mockTransitionStatus.mock.calls[0][2]).not.toHaveProperty('claimerId');
    });

    it('refuses to close when the ticket moved out of open underneath it', async () => {
        mockGetById.mockResolvedValue(ticket());
        mockTransitionStatus.mockResolvedValue(null);

        expect((await closeTicket(1)).ok).toBe(false);
    });

    it('refuses to close an already closed ticket', async () => {
        mockGetById.mockResolvedValue(ticket({ status: 'closed' }));

        expect((await closeTicket(1)).ok).toBe(false);
    });

    it('reopens a closed ticket and clears closedAt', async () => {
        mockGetById.mockResolvedValue(ticket({ status: 'closed', closedAt: new Date() }));

        const result = await reopenTicket(1);

        expect(result.ok).toBe(true);
        expect(mockTransitionStatus).toHaveBeenCalledWith(1, 'closed', { status: 'open', closedAt: null });
    });

    it('marks deleted without removing the row, so a delete trigger has something to fire on', async () => {
        mockGetById.mockResolvedValue(ticket());

        const result = await deleteTicket(1);

        expect(result.ok).toBe(true);
        // Guarded on the status just read, because deleting is legal from both
        // `open` and `closed`.
        expect(mockTransitionStatus).toHaveBeenCalledWith(1, 'open', {
            status: 'deleted',
            deletedAt: expect.any(String),
            channelId: null,
        });
    });

    it('deletes a closed ticket too, guarding on the status it actually had', async () => {
        mockGetById.mockResolvedValue(ticket({ status: 'closed' }));

        expect((await deleteTicket(1)).ok).toBe(true);
        expect(mockTransitionStatus).toHaveBeenCalledWith(1, 'closed', expect.objectContaining({ status: 'deleted' }));
    });

    it('refuses to reopen a deleted ticket', async () => {
        mockGetById.mockResolvedValue(ticket({ status: 'deleted' }));

        expect((await reopenTicket(1)).ok).toBe(false);
    });
});

describe('hasOpenTicket', () => {
    it('answers from the record without a Discord call', async () => {
        mockFindOpenBySubject.mockResolvedValue([ticket({ type: 'verification' })]);

        expect(await hasOpenTicket('guild-1', 'subject-1', 'verification')).toBe(true);
        expect(mockFindOpenBySubject).toHaveBeenCalledWith('guild-1', 'subject-1', 'verification');
    });

    it('is false when the subject has none of that type', async () => {
        mockFindOpenBySubject.mockResolvedValue([]);

        expect(await hasOpenTicket('guild-1', 'subject-1', 'verification')).toBe(false);
    });
});
