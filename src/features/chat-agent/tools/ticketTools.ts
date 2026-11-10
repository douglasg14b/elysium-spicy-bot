import { tool } from 'ai';
import { z } from 'zod';
import { getTicketByChannel, type TicketEntity } from '../../tickets';
import { ticketingRepo } from '../../tickets/data/ticketingRepo';
import { ticketsRepo } from '../../tickets/data/ticketsRepo';
import { memberHandlesTickets } from '../../tickets/logic/hasModeratorRole';
import { channelIdFromReference } from './channelReferences';
import type { ChatToolContext } from './chatToolContext';
import { findMember } from './memberTools';
import { staffOnlyRefusal } from './staffAccess';
import { everyoneCanSee } from './visibleChannels';

/** Tickets `findTickets` lists, newest first. */
const FOUND_TICKET_LIMIT = 10;

/** A ticket's reason is cut in a list; one ticket's channel has the rest. */
const LISTED_REASON_LIMIT = 500;

/** Who a ticket's name snapshot says someone is: nickname, else username. */
function snapshotName(nickname: string | null, username: string | null): string | null {
    return nickname ?? username;
}

/** A ticket as the model reads it, without where it lives. */
function describeTicket(ticket: TicketEntity) {
    return {
        number: ticket.ticketNumber,
        type: ticket.type,
        status: ticket.status,
        title: ticket.title,
        reason: ticket.reason,
        openedFor: snapshotName(ticket.subjectNickname, ticket.subjectUsername),
        claimedBy: ticket.claimerId ? snapshotName(ticket.claimerNickname, ticket.claimerUsername) : null,
        openedAt: ticket.openedAt.toISOString(),
    };
}

export function getTicketInfoTool(context: ChatToolContext) {
    return tool({
        description:
            'Details of the ticket this channel is: its number, type, status, title and reason, who it is for, and which moderator has claimed it. Only this channel’s ticket.',
        inputSchema: z.object({}),
        execute: async () => {
            const { ticket } = context;
            if (!ticket) return { isTicket: false as const };
            return { isTicket: true as const, ...describeTicket(ticket) };
        },
    });
}

/** The tickets `query` names: a number, a ticket channel (mention, link or exact #name), else a member — who they are now, or, someone who has left, the names their tickets recorded. At most one past {@link FOUND_TICKET_LIMIT}, so a caller can tell there are more. */
async function ticketsMatching(context: ChatToolContext, query: string): Promise<readonly TicketEntity[]> {
    const { guild } = context;
    const trimmed = query.trim();
    const number = /^#?(\d{1,9})$/.exec(trimmed)?.[1];
    if (number) return ticketsRepo.searchByGuild(guild.id, number);

    const channelId =
        channelIdFromReference(trimmed) ??
        guild.channels.cache.find((channel) => `#${channel.name}`.toLowerCase() === trimmed.toLowerCase())?.id;
    if (channelId) {
        // The one lookup not scoped to the guild by its query.
        const ticket = await getTicketByChannel(channelId);
        return ticket && ticket.guildId === guild.id ? [ticket] : [];
    }

    const member = await findMember(guild, trimmed);
    if (member) return ticketsRepo.listBySubject(guild.id, member.id, FOUND_TICKET_LIMIT + 1);
    return ticketsRepo.searchByGuild(guild.id, trimmed.replace(/^@/, ''), { subjectOnly: true });
}

/** A ticket as `findTickets` lists it: its details and where it lives. */
export type FoundTicket = ReturnType<typeof describeTicket> & { readonly channel: string };

/**
 * Where a ticket is, said only to readers who could find it themselves: its #channel when
 * every reader can see it; "gone" when it has no channel left and every reader handles
 * tickets. Undefined when it is not theirs to hear about.
 */
function ticketLocation(context: ChatToolContext, ticket: TicketEntity, everyReaderHandlesTickets: boolean): string | undefined {
    const channel = ticket.channelId ? context.guild.channels.cache.get(ticket.channelId) : undefined;
    if (channel) return everyoneCanSee(context.viewers, channel) ? `#${channel.name}` : undefined;
    return everyReaderHandlesTickets ? 'its channel is gone' : undefined;
}

/**
 * Staff finding tickets — by number, by member (any status), or by their channel. A ticket
 * is described only to readers who could find it themselves (`ticketLocation`); the rest
 * are counted, not described.
 */
export function findTicketsTool(context: ChatToolContext) {
    return tool({
        description:
            "For staff: find tickets on this server — by number (\"42\"), by member (their name or @mention: every ticket about them, closed ones too), or by a ticket's channel (#name, mention or link). Each comes with its details and its #channel, which readChannelMessages reads. It says who may hear the answer.",
        inputSchema: z.object({
            query: z.string().min(1).describe('A ticket number, a member, or a ticket channel.'),
        }),
        execute: async ({ query }) => {
            const refusal = staffOnlyRefusal(context);
            if (refusal) return { found: false as const, ...refusal };

            const matches = await ticketsMatching(context, query);
            if (matches.length === 0) return { found: false as const, note: `No ticket matching "${query}".` };

            const moderationRoles = (await ticketingRepo.get(context.guild.id))?.config.moderationRoles ?? [];
            const everyReaderHandlesTickets = context.viewers.every((member) => memberHandlesTickets(member, moderationRoles));
            const listed = matches.slice(0, FOUND_TICKET_LIMIT);
            const tickets: FoundTicket[] = listed.flatMap((ticket) => {
                const channel = ticketLocation(context, ticket, everyReaderHandlesTickets);
                return channel ? [{ ...describeTicket(ticket), reason: ticket.reason.slice(0, LISTED_REASON_LIMIT), channel }] : [];
            });
            const hidden = listed.length - tickets.length;
            return {
                found: true as const,
                tickets,
                ...(hidden > 0 ? { notShown: `${hidden} more that not everyone here could find themselves` } : {}),
                ...(matches.length > FOUND_TICKET_LIMIT ? { more: 'Older ones were not listed: ask about one by its number.' } : {}),
            };
        },
    });
}
