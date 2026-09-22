import { describe, expect, it } from 'vitest';
import { availableActions } from '../ticketActions';
import type { TicketParticipant } from '../../api/types';

/**
 * Which actions a row offers.
 *
 * The same rule `buildTicketButtons` applies in Discord, which is the reason it is one
 * function: two copies of "claim needs open-and-unclaimed" is two places for the
 * dashboard and the in-channel buttons to start disagreeing about the same ticket.
 */

const CLAIMER: TicketParticipant = { id: 'mod-1', username: 'moduser', nickname: 'Mod' };

describe('availableActions', () => {
    it('offers claim on an open unclaimed ticket, and not unclaim', () => {
        expect(availableActions({ status: 'open', claimer: null })).toEqual(['claim', 'close']);
    });

    it('offers unclaim and close on an open claimed ticket, and not claim', () => {
        expect(availableActions({ status: 'open', claimer: CLAIMER })).toEqual(['unclaim', 'close']);
    });

    it('offers only reopen on a closed ticket', () => {
        // Closing keeps the claim — who handled it is a fact about a finished ticket —
        // so a closed ticket having a claimer must not bring unclaim back.
        expect(availableActions({ status: 'closed', claimer: CLAIMER })).toEqual(['reopen']);
    });

    it('offers only reopen on a closed unclaimed ticket too', () => {
        expect(availableActions({ status: 'closed', claimer: null })).toEqual(['reopen']);
    });

    it('offers nothing on a deleted ticket', () => {
        // Its channel is gone, so there is nothing left to move or re-permission.
        expect(availableActions({ status: 'deleted', claimer: CLAIMER })).toEqual([]);
    });

    it('never offers delete, which stays in Discord', () => {
        const everyState = [
            availableActions({ status: 'open', claimer: null }),
            availableActions({ status: 'open', claimer: CLAIMER }),
            availableActions({ status: 'closed', claimer: CLAIMER }),
            availableActions({ status: 'deleted', claimer: null }),
        ].flat();

        // Deleting a ticket destroys its channel and is explicitly out of scope on the
        // web side. Asserted rather than assumed, because it is a scope decision a later
        // edit could quietly reverse.
        expect(everyState).not.toContain('delete');
    });
});
