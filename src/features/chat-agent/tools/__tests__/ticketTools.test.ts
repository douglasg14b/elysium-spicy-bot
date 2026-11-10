import { Collection, type Guild, type GuildMember, type GuildTextBasedChannel } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { TicketEntity } from '../../../tickets';
import type { ChatToolContext } from '../chatToolContext';
import type { Viewers } from '../visibleChannels';

const STAFF_ROLE = 'role-staff';
const MOD_ROLE = 'role-mods';

function ticket(ticketNumber: number, channelId: string | null): TicketEntity {
    return {
        id: ticketNumber,
        guildId: 'guild',
        ticketNumber,
        type: 'support',
        status: channelId ? 'open' : 'deleted',
        title: `Ticket ${ticketNumber}`,
        reason: 'Someone keeps DMing me.',
        subjectId: 'vex',
        subjectUsername: 'vex_irl',
        subjectNickname: 'Vex',
        claimerId: null,
        claimerUsername: null,
        claimerNickname: null,
        openedAt: new Date('2026-11-01T00:00:00Z'),
        channelId,
    } as unknown as TicketEntity;
}

const TICKETS = [ticket(42, 'ticket-42'), ticket(41, 'ticket-41-hidden'), ticket(40, null)];

/** The repo's search: a number matches that ticket exactly. */
const searchByGuild = vi.fn(async (_guildId: string, query: string, _filter?: { subjectOnly?: boolean }) =>
    TICKETS.filter((candidate) => `${candidate.ticketNumber}` === query)
);
const listBySubject = vi.fn(async () => TICKETS);
vi.mock('../../../tickets/data/ticketsRepo', () => ({ ticketsRepo: { searchByGuild, listBySubject } }));
vi.mock('../../../tickets/data/ticketingRepo', () => ({
    ticketingRepo: { get: async () => ({ config: { moderationRoles: [MOD_ROLE] } }) },
}));
vi.mock('../../../tickets', () => ({
    getTicketByChannel: async (channelId: string) => TICKETS.find((candidate) => candidate.channelId === channelId) ?? null,
}));
vi.mock('../memberTools', () => ({
    findMember: async (_guild: Guild, query: string) => (query === 'Vex' ? { id: 'vex' } : undefined),
}));

const { findTicketsTool } = await import('../ticketTools');

function channel(id: string, name: string, seenBy: readonly string[]) {
    return [id, { id, name, type: 0, permissionsFor: (who: { id: string }) => ({ has: () => seenBy.includes(who.id) }) }] as const;
}

const guild = {
    id: 'guild',
    ownerId: 'owner',
    memberCount: 2,
    members: { cache: { size: 2 } },
    channels: { cache: new Collection([channel('ticket-42', 'ticket-0042-vex', ['mod', 'helper']), channel('ticket-41-hidden', 'ticket-0041-vex', ['mod'])]) },
};

function member(id: string, roles: string[]): GuildMember {
    return {
        id,
        guild,
        permissions: { has: () => false },
        roles: { cache: new Map(roles.map((roleId) => [roleId, { id: roleId }])) },
    } as unknown as GuildMember;
}

const mod = member('mod', [STAFF_ROLE, MOD_ROLE]);
const helper = member('helper', [STAFF_ROLE]);
const vex = member('vex', []);

async function find(viewers: Viewers, query: string) {
    const context = {
        guild: guild as unknown as Guild,
        channel: { id: 'staff-room' } as unknown as GuildTextBasedChannel,
        asker: viewers[0],
        viewers,
        staffRoleIds: [STAFF_ROLE],
    } as unknown as ChatToolContext;
    const execute = findTicketsTool(context).execute;
    if (!execute) throw new Error('findTickets has no execute');
    return execute({ query }, { toolCallId: 'call-1', messages: [], context: undefined } as never);
}

describe('findTickets', () => {
    it('finds a ticket by number, with the #channel readChannelMessages reads', async () => {
        const answer = await find([mod], '#42');

        expect(searchByGuild).toHaveBeenCalledWith('guild', '42');
        expect(answer).toMatchObject({ found: true, tickets: [{ number: 42, openedFor: 'Vex', channel: '#ticket-0042-vex' }] });
    });

    it("finds a member's tickets, closed and deleted ones too", async () => {
        await find([mod], 'Vex');
        // One past the ten it lists, so it can say there are older ones.
        expect(listBySubject).toHaveBeenCalledWith('guild', 'vex', 11);
    });

    it('finds a member who has left by the names on tickets about them, not ones they opened or claimed', async () => {
        await find([mod], 'Damon');
        expect(searchByGuild).toHaveBeenCalledWith('guild', 'Damon', { subjectOnly: true });
    });

    it('finds the ticket a channel is', async () => {
        expect(await find([mod], '#ticket-0042-vex')).toMatchObject({ found: true, tickets: [{ number: 42 }] });
    });

    it('describes only tickets every reader could find for themselves, and counts the rest', async () => {
        // The mod sees both channels and handles tickets: everything.
        const alone = await find([mod], 'Vex');
        expect(alone).toMatchObject({ tickets: [{ number: 42 }, { number: 41 }, { number: 40, channel: 'its channel is gone' }] });

        // With a staff member who can't see #ticket-0041 and doesn't handle tickets: only 42.
        const withHelper = await find([mod, helper], 'Vex');
        expect(withHelper).toMatchObject({ tickets: [{ number: 42 }], notShown: '2 more that not everyone here could find themselves' });
        expect(JSON.stringify(withHelper)).not.toMatch(/ticket-0041|Ticket 41|Ticket 40/);
    });

    it("refuses a member who isn't staff before looking anything up", async () => {
        searchByGuild.mockClear();
        expect(await find([vex], '42')).toMatchObject({ found: false, reason: 'Only staff can ask this.' });
        expect(searchByGuild).not.toHaveBeenCalled();
    });
});
