import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TICKET_TYPES } from '../data/defaultTicketTypes';
import type { TicketEntity, TicketIdentity } from '../data/ticketsSchema';

const mockCreate = vi.fn();
const mockGetById = vi.fn();
const mockUpdate = vi.fn();
const mockFindOpenBySubject = vi.fn();
const mockHasOpenBySubject = vi.fn();
const mockIncrementTicketNumber = vi.fn();
const mockClaimIfUnclaimed = vi.fn();
const mockTransitionStatus = vi.fn();

vi.mock('../data/ticketsRepo', () => ({
    ticketsRepo: {
        create: (...args: unknown[]) => mockCreate(...args),
        getById: (...args: unknown[]) => mockGetById(...args),
        update: (...args: unknown[]) => mockUpdate(...args),
        findOpenBySubject: (...args: unknown[]) => mockFindOpenBySubject(...args),
        hasOpenBySubject: (...args: unknown[]) => mockHasOpenBySubject(...args),
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
    type OpenTicketInput,
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
        subjectUsername: null,
        subjectNickname: null,
        openerUsername: null,
        openerNickname: null,
        claimerUsername: null,
        claimerNickname: null,
        stateMessageId: null,
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

const SUBJECT_IDENTITY: TicketIdentity = { username: 'subjectuser', nickname: 'Kitten' };
const OPENER_IDENTITY: TicketIdentity = { username: 'openeruser', nickname: null };

/** The two seeded definitions, which callers now resolve and hand to the service. */
const SUPPORT = DEFAULT_TICKET_TYPES.support;
const VERIFICATION = DEFAULT_TICKET_TYPES.verification;

function openInput(overrides: Partial<OpenTicketInput> = {}): OpenTicketInput {
    return {
        guildId: 'guild-1',
        type: 'support',
        definition: SUPPORT,
        subjectId: 'subject-1',
        openerId: 'opener-1',
        title: 'Title',
        reason: 'Reason',
        subjectIdentity: SUBJECT_IDENTITY,
        openerIdentity: OPENER_IDENTITY,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockImplementation(async (values: Record<string, unknown>) => ticket(values as Partial<TicketEntity>));
    mockUpdate.mockImplementation(async (id: number, changes: Record<string, unknown>) =>
        ticket({ id, ...(changes as Partial<TicketEntity>) })
    );
    mockIncrementTicketNumber.mockResolvedValue(7);
    mockClaimIfUnclaimed.mockImplementation(
        async (id: number, claimerId: string, claimedAt: string, identity: TicketIdentity | null) =>
            ticket({
                id,
                claimerId,
                claimedAt: new Date(claimedAt),
                claimerUsername: identity?.username ?? null,
                claimerNickname: identity?.nickname ?? null,
            })
    );
    mockTransitionStatus.mockImplementation(async (id: number, _from: string, changes: Record<string, unknown>) =>
        ticket({ id, ...(changes as Partial<TicketEntity>) })
    );
});

describe('openTicket', () => {
    it('allocates the ticket number atomically before any channel exists', async () => {
        const result = await openTicket(openInput());

        expect(result.ok).toBe(true);
        expect(mockIncrementTicketNumber).toHaveBeenCalledWith('guild-1');
        expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ ticketNumber: 7, channelId: null }));
    });

    it('auto-claims to the opener when the passed definition says so, recording the opener’s identity as the claimer’s', async () => {
        // The decision comes from the definition handed in, not from a lookup this
        // module performs — which is what keeps the service testable without a
        // database and without reading `ticketing_config`.
        await openTicket(openInput());

        expect(mockCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                claimerId: 'opener-1',
                claimedAt: expect.any(String),
                // One person, so one pair of names: the auto-claimer *is* the opener.
                claimerUsername: OPENER_IDENTITY.username,
                claimerNickname: OPENER_IDENTITY.nickname,
            })
        );
    });

    it('records both identities on the row rather than only the ids', async () => {
        await openTicket(openInput());

        expect(mockCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                subjectUsername: 'subjectuser',
                subjectNickname: 'Kitten',
                openerUsername: 'openeruser',
                // Null means "no nickname set", not "not recorded" — the two are
                // distinguishable, which is the reason `nickname` is stored and
                // `displayName` is not.
                openerNickname: null,
            })
        );
    });

    it('records nulls rather than placeholders when an identity could not be resolved', async () => {
        await openTicket(openInput({ subjectIdentity: null, openerIdentity: null }));

        expect(mockCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                subjectUsername: null,
                subjectNickname: null,
                openerUsername: null,
                openerNickname: null,
            })
        );
    });

    it('opens a verification ticket unclaimed and with no opener', async () => {
        // The case the old creation path could not express at all: it took the
        // opener from `interaction.user` and always auto-claimed.
        await openTicket(
            openInput({
                type: 'verification',
                definition: VERIFICATION,
                openerId: null,
                openerIdentity: null,
                title: 'Verify',
                reason: 'Flow opened',
            })
        );

        expect(mockCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                openerId: null,
                claimerId: null,
                claimedAt: null,
                status: 'open',
                claimerUsername: null,
                claimerNickname: null,
            })
        );
    });

    it('leaves a claimer nameless when the definition does not auto-claim, even with an opener present', async () => {
        // A definition is the only thing that decides this, so a verification-shaped
        // type with a human opener must still open unclaimed.
        await openTicket(openInput({ type: 'verification', definition: VERIFICATION }));

        expect(mockCreate).toHaveBeenCalledWith(
            expect.objectContaining({ claimerId: null, claimerUsername: null, claimerNickname: null })
        );
    });

    it('does not create a record when the number cannot be allocated', async () => {
        mockIncrementTicketNumber.mockRejectedValue(new Error('no config'));

        const result = await openTicket(openInput());

        expect(result.ok).toBe(false);
        expect(mockCreate).not.toHaveBeenCalled();
    });
});

describe('claim and unclaim are independent of lifecycle', () => {
    const CLAIMER_IDENTITY: TicketIdentity = { username: 'moduser', nickname: 'Mod' };

    it('claims an open, unclaimed ticket, carrying the claimer’s names into the same statement', async () => {
        mockGetById.mockResolvedValue(ticket({ claimerId: null }));

        const result = await claimTicket(1, 'mod-1', CLAIMER_IDENTITY);

        expect(result.ok).toBe(true);
        // A conditional UPDATE, not a read-then-write: the `where` clause is
        // what decides, so a second claimer racing the first gets nothing back. The
        // identity travels as a fourth argument of that *same* update rather than a
        // follow-up write, so a refused claim cannot leave its name behind.
        expect(mockClaimIfUnclaimed).toHaveBeenCalledWith(1, 'mod-1', expect.any(String), CLAIMER_IDENTITY);
    });

    it('reports a loss to a racing claimer instead of overwriting them', async () => {
        mockGetById.mockResolvedValue(ticket({ claimerId: null }));
        // Zero rows back is how the database says "someone got here first".
        mockClaimIfUnclaimed.mockResolvedValue(null);

        const result = await claimTicket(1, 'mod-1', CLAIMER_IDENTITY);

        expect(result.ok).toBe(false);
    });

    it('refuses to claim a ticket someone else holds', async () => {
        mockGetById.mockResolvedValue(ticket({ claimerId: 'mod-other' }));

        const result = await claimTicket(1, 'mod-1', CLAIMER_IDENTITY);

        expect(result.ok).toBe(false);
        expect(mockUpdate).not.toHaveBeenCalled();
        expect(mockClaimIfUnclaimed).not.toHaveBeenCalled();
    });

    it('refuses to claim a closed ticket', async () => {
        mockGetById.mockResolvedValue(ticket({ status: 'closed', claimerId: null }));

        expect((await claimTicket(1, 'mod-1', CLAIMER_IDENTITY)).ok).toBe(false);
    });

    it('unclaims without changing the lifecycle status, and clears the claimer’s names with the claim', async () => {
        // The transition the old three-value enum could not represent: unclaiming
        // meant moving back to `active`, which conflated ownership with lifecycle.
        mockGetById.mockResolvedValue(
            ticket({ claimerId: 'mod-1', claimerUsername: 'moduser', claimerNickname: 'Mod' })
        );

        const result = await unclaimTicket(1);

        expect(result.ok).toBe(true);
        // A released ticket keeps no claimer, so it keeps no claimer name. Leaving the
        // names behind would say a ticket nobody holds was handled by somebody.
        expect(mockUpdate).toHaveBeenCalledWith(1, {
            claimerId: null,
            claimedAt: null,
            claimerUsername: null,
            claimerNickname: null,
        });
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

    it('leaves all three identities untouched on close — no member is re-resolved', async () => {
        mockGetById.mockResolvedValue(ticket({ claimerId: 'mod-1', claimerUsername: 'moduser' }));

        await closeTicket(1);

        // Closing changes no person, so it re-resolves nobody. Re-resolving the subject
        // here would add a Discord call to a transition that currently needs none —
        // exactly the cost the snapshot columns exist to remove.
        const changes = mockTransitionStatus.mock.calls[0][2] as Record<string, unknown>;
        for (const column of [
            'subjectUsername',
            'subjectNickname',
            'openerUsername',
            'openerNickname',
            'claimerUsername',
            'claimerNickname',
        ]) {
            expect(changes).not.toHaveProperty(column);
        }
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
        mockHasOpenBySubject.mockResolvedValue(true);

        expect(await hasOpenTicket('guild-1', 'subject-1', 'verification')).toBe(true);
        expect(mockHasOpenBySubject).toHaveBeenCalledWith('guild-1', 'subject-1', 'verification');
    });

    it('is false when the subject has none of that type', async () => {
        mockHasOpenBySubject.mockResolvedValue(false);

        expect(await hasOpenTicket('guild-1', 'subject-1', 'verification')).toBe(false);
    });

    it('does not fetch rows to answer a yes/no on the hot path', async () => {
        // Runs per member on join, so selecting every column — `reason` is
        // unbounded text — to check `length > 0` would defeat the covering index.
        mockHasOpenBySubject.mockResolvedValue(true);

        await hasOpenTicket('guild-1', 'subject-1');

        expect(mockFindOpenBySubject).not.toHaveBeenCalled();
    });
});
