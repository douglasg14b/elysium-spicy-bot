import { SUPPORT_TICKET_NAME_TEMPLATE } from '../constants';

interface TicketChannelNameParams {
    ticketId: number;
    targetUserName: string;
    creatorUserName: string;
}

export function buildTicketChannelName(params: TicketChannelNameParams): string {
    return SUPPORT_TICKET_NAME_TEMPLATE.replace('{{####}}', params.ticketId.toString().padStart(4, '0'))
        .replace('{{user}}', params.targetUserName.replace(/[^a-z0-9-]/g, '').toLowerCase())
        .replace('{{creator}}', params.creatorUserName.replace(/[^a-z0-9-]/g, '').toLowerCase());
}
