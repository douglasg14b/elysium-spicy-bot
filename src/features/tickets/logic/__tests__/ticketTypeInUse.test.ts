import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TICKET_TYPES } from '../../data/defaultTicketTypes';
import type { TicketingConfig, TicketingConfigEntity } from '../../data/ticketingSchema';
import type { TicketEntity, TicketStatus } from '../../data/ticketsSchema';
import { deleteTicketType, type SetTicketTypesDeps } from '../setTicketTypes';
import { ticketTypeInUseRefusal, ticketTypeUsage, type TicketTypeUsageDeps } from '../ticketTypeInUse';

/**
 * The cascade refusal: deleting a ticket type while tickets still hold it.
 *
 * Tested through `deleteTicketType` and not only against `ticketTypeUsage`, because
 * an unconditional delete also leaves a green suite — the counting function would go
 * on counting correctly while nothing consulted it. The precedent this is modelled on
 * (`provisioning/logic/sharedJourneyGuard.ts`) has no unit test of its own and is
 * covered only through its route; testing the query directly is an improvement on it
 * rather than a deviation.
 */

function config(): TicketingConfig {
    return {
        modTicketsDeployed: true,
        modTicketsDeployedChannelId: 'channel-1',
        modTicketsDeployedMessageId: 'message-1',
        supportTicketCategoryName: 'Support',
        claimedTicketCategoryName: 'Claimed',
        closedTicketCategoryName: 'Closed',
        moderationRoles: ['role-1'],
        ticketTypes: { ...DEFAULT_TICKET_TYPES },
    };
}

/** Rows shaped only as far as the usage query reads them: number and status. */
function heldBy(tickets: { ticketNumber: number; status: TicketStatus }[]): TicketTypeUsageDeps {
    const counted = tickets.reduce<Partial<Record<TicketStatus, number>>>((totals, ticket) => {
        totals[ticket.status] = (totals[ticket.status] ?? 0) + 1;
        return totals;
    }, {});

    return {
        tickets: {
            countByType: async () =>
                Object.entries(counted).map(([status, count]) => ({ status: status as TicketStatus, count: count ?? 0 })),
            listByType: async (_guildId: string, _type: string, limit: number) =>
                [...tickets]
                    .sort((left, right) => right.ticketNumber - left.ticketNumber)
                    .slice(0, limit) as TicketEntity[],
        },
    };
}

interface Harness {
    readonly deps: SetTicketTypesDeps;
    readonly update: ReturnType<typeof vi.fn>;
}

function harness(usage: TicketTypeUsageDeps): Harness {
    const update = vi.fn().mockResolvedValue(undefined);
    const stored = config();

    return {
        deps: {
            repo: {
                get: async () =>
                    ({
                        id: 1,
                        guildId: 'guild-1',
                        config: stored,
                        ticketNumberInc: 9,
                        entityVersion: 1,
                    }) as TicketingConfigEntity,
                update,
            },
            usage,
        },
        update,
    };
}

describe('deleting a type tickets still hold', () => {
    it('refuses deleting a type while an open ticket holds it, naming the count and an example number', async () => {
        const held = harness(heldBy([{ ticketNumber: 42, status: 'open' }]));

        const result = await deleteTicketType('guild-1', 'support', held.deps);

        expect(result.ok).toBe(false);
        // Both halves matter: the count is the size of the problem, the number is what
        // an operator finds the ticket by — a ticket has no name.
        expect(result.ok === false && result.message).toContain('1 open');
        expect(result.ok === false && result.message).toContain('#0042');
        // And nothing was written. A refusal that still saved would be the defect.
        expect(held.update).not.toHaveBeenCalled();
    });

    it('refuses deleting a type held only by deleted tickets', async () => {
        const held = harness(heldBy([{ ticketNumber: 7, status: 'deleted' }]));

        const result = await deleteTicketType('guild-1', 'support', held.deps);

        expect(result.ok).toBe(false);
        expect(result.ok === false && result.message).toContain('1 deleted');
        // An operator will find this surprising, so the copy has to explain itself
        // rather than just printing a number.
        expect(result.ok === false && result.message).toContain('history');
        expect(held.update).not.toHaveBeenCalled();
    });

    it('allows deleting a type no ticket has ever used', async () => {
        const held = harness(heldBy([]));

        const result = await deleteTicketType('guild-1', 'support', held.deps);

        // The control: this is what proves the two refusals above were covering the
        // gate rather than something that refuses everything.
        expect(result.ok).toBe(true);
        expect(held.update).toHaveBeenCalledTimes(1);
    });

    it('names all three status counts when the type spans statuses', async () => {
        const held = harness(
            heldBy([
                { ticketNumber: 1, status: 'open' },
                { ticketNumber: 2, status: 'open' },
                { ticketNumber: 3, status: 'closed' },
                { ticketNumber: 4, status: 'deleted' },
            ])
        );

        const result = await deleteTicketType('guild-1', 'support', held.deps);

        expect(result.ok).toBe(false);
        const message = result.ok === false ? result.message : '';
        expect(message).toContain('2 open');
        expect(message).toContain('1 closed');
        expect(message).toContain('1 deleted');
    });
});

describe('ticketTypeUsage', () => {
    it('counts each status separately and caps the examples at five, newest first', async () => {
        const many = Array.from({ length: 8 }, (_unused, index) => ({
            ticketNumber: index + 1,
            status: 'open' as const,
        }));

        const usage = await ticketTypeUsage('guild-1', 'support', heldBy(many));

        expect(usage.openCount).toBe(8);
        expect(usage.closedCount).toBe(0);
        expect(usage.examples).toHaveLength(5);
        // Newest first, so the examples are the ones an operator most likely recognises.
        expect(usage.examples[0]?.ticketNumber).toBe(8);
    });

    it('reports zeroes rather than omitting a status nothing holds', async () => {
        const usage = await ticketTypeUsage('guild-1', 'support', heldBy([]));

        expect(usage).toMatchObject({ openCount: 0, closedCount: 0, deletedCount: 0 });
        expect(usage.examples).toEqual([]);
    });
});

describe('ticketTypeInUseRefusal', () => {
    it('reads as a sentence with one holder and with several', () => {
        const single = ticketTypeInUseRefusal({
            label: 'Support',
            type: 'support',
            usage: { openCount: 1, closedCount: 0, deletedCount: 0, examples: [] },
        });
        expect(single).toContain('1 open.');
        expect(single).not.toContain('and');

        const several = ticketTypeInUseRefusal({
            label: 'Support',
            type: 'support',
            usage: { openCount: 2, closedCount: 3, deletedCount: 0, examples: [] },
        });
        expect(several).toContain('2 open and 3 closed');
    });
});
