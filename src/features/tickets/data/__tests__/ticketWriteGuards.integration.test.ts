import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migrateTestDatabase } from '../../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import { clearTicketSubscribers, registerTicketSubscriber, type TicketChangeEvent } from '../../ticketChanges';
import { attachTicketChannel, closeTicket, recordTicketStateMessage, unclaimTicket } from '../../ticketService';
import { ticketsRepo } from '../ticketsRepo';
import type { TicketEntity } from '../ticketsSchema';

/**
 * The conditional writes that make each announcement fire once, against real SQLite.
 *
 * The service tests prove what the service does with a row or a null; only the database
 * can prove the `where` clause hands back the null. Two releases racing, a stale release
 * after a fresh claim, a second attach and a second record are each one statement whose
 * guard either holds or does not.
 */

const BY_A_PERSON = { actorId: 'mod-1', chainDepth: 0 };

let ticketNumber = 0;

async function aTicket(overrides: Partial<Parameters<typeof ticketsRepo.create>[0]> = {}): Promise<TicketEntity> {
    ticketNumber += 1;
    const now = new Date().toISOString();
    return ticketsRepo.create({
        guildId: 'guild-1',
        ticketNumber,
        type: 'aftercare',
        status: 'open',
        subjectId: 'subject-1',
        openerId: null,
        claimerId: null,
        channelId: null,
        subjectUsername: null,
        subjectNickname: null,
        openerUsername: null,
        openerNickname: null,
        claimerUsername: null,
        claimerNickname: null,
        stateMessageId: null,
        title: 'Checking in',
        reason: 'After a heavy scene.',
        openedAt: now,
        claimedAt: null,
        closedAt: null,
        deletedAt: null,
        updatedAt: now,
        ...overrides,
    });
}

let announced: TicketChangeEvent[] = [];

beforeAll(async () => {
    await migrateTestDatabase();
});

afterEach(() => {
    clearTicketSubscribers();
    announced = [];
});

function listen(): void {
    registerTicketSubscriber((event) => {
        announced.push(event);
    });
}

describe('releasing a claim', () => {
    it('lets only one of two racing unclaims land, and announces only that one', async () => {
        const ticket = await ticketsRepo.claimIfUnclaimed((await aTicket()).id, 'mod-1', new Date().toISOString(), null);
        if (!ticket) throw new Error('The ticket could not be claimed to begin with.');
        listen();

        // Both read `mod-1` as the claimer before either writes.
        const [first, second] = await Promise.all([unclaimTicket(ticket.id, BY_A_PERSON), unclaimTicket(ticket.id, BY_A_PERSON)]);

        expect([first.ok, second.ok].sort()).toEqual([false, true]);
        expect(announced.map((event) => event.kind)).toEqual(['unclaimed']);
    });

    it('does not let a release that read a stale claim wipe a fresh one', async () => {
        const id = (await aTicket()).id;
        await ticketsRepo.claimIfUnclaimed(id, 'mod-1', new Date().toISOString(), null);
        await ticketsRepo.releaseClaimIf(id, 'mod-1');
        await ticketsRepo.claimIfUnclaimed(id, 'mod-2', new Date().toISOString(), { username: 'mod2', nickname: null });

        // A release still holding mod-1 as the claimer it read.
        expect(await ticketsRepo.releaseClaimIf(id, 'mod-1')).toBeNull();
        expect((await ticketsRepo.getById(id))?.claimerId).toBe('mod-2');
    });
});

describe('announcing a ticket as opened', () => {
    it('fires once, on the first state message recorded — not on attach, and not on a second record', async () => {
        const id = (await aTicket()).id;
        listen();

        expect((await attachTicketChannel(id, 'channel-1')).ok).toBe(true);
        expect(announced).toEqual([]);

        expect((await recordTicketStateMessage(id, 'state-1', BY_A_PERSON)).ok).toBe(true);
        expect((await recordTicketStateMessage(id, 'state-2', BY_A_PERSON)).ok).toBe(false);

        expect(announced.map((event) => event.kind)).toEqual(['opened']);
        expect((await ticketsRepo.getById(id))?.stateMessageId).toBe('state-1');
    });

    it('attaches only an open ticket with no channel, and records only on an open one', async () => {
        const id = (await aTicket()).id;
        expect((await attachTicketChannel(id, 'channel-1')).ok).toBe(true);
        expect((await attachTicketChannel(id, 'channel-2')).ok).toBe(false);
        expect((await ticketsRepo.getById(id))?.channelId).toBe('channel-1');

        await closeTicket(id, BY_A_PERSON);
        expect((await recordTicketStateMessage(id, 'state-1', BY_A_PERSON)).ok).toBe(false);

        const closed = await aTicket({ status: 'closed' });
        expect((await attachTicketChannel(closed.id, 'channel-3')).ok).toBe(false);
    });
});
