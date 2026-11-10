import { tool } from 'ai';
import { z } from 'zod';
import type { ChatToolContext } from './chatToolContext';

/** Who a ticket's name snapshot says someone is: nickname, else username. */
function snapshotName(nickname: string | null, username: string | null): string | null {
    return nickname ?? username;
}

export function getTicketInfoTool(context: ChatToolContext) {
    return tool({
        description:
            'Details of the ticket this channel is: its number, type, status, title and reason, who it is for, and which moderator has claimed it. Only this channel’s ticket.',
        inputSchema: z.object({}),
        execute: async () => {
            const { ticket } = context;
            if (!ticket) return { isTicket: false as const };
            return {
                isTicket: true as const,
                number: ticket.ticketNumber,
                type: ticket.type,
                status: ticket.status,
                title: ticket.title,
                reason: ticket.reason,
                openedFor: snapshotName(ticket.subjectNickname, ticket.subjectUsername),
                claimedBy: ticket.claimerId ? snapshotName(ticket.claimerNickname, ticket.claimerUsername) : null,
                openedAt: ticket.openedAt.toISOString(),
            };
        },
    });
}
