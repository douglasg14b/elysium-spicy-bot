import { TICKETING_CONFIG } from '../ticketsConfig';

interface TicketChannelNameParams {
    ticketId: number;
    targetUserName: string;
    creatorUserName: string;
}

export function buildTicketChannelName(params: TicketChannelNameParams): string {
    return TICKETING_CONFIG.ticketChannelNamePrefix
        .replace('{{####}}', params.ticketId.toString().padStart(4, '0'))
        .replace('{{user}}', params.targetUserName.replace(/[^a-z0-9-]/g, '').toLowerCase())
        .replace('{{creator}}', params.creatorUserName.replace(/[^a-z0-9-]/g, '').toLowerCase());
}
