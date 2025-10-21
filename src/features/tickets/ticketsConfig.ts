export type TicketingConfig = {
    supportTicketCategoryName: string;
    closedTicketCategoryName: string;
    ticketChannelNamePrefix: string;
    moderationRoles: string[];
};

// TODO: Hardcoded for now, probably should be configurable later
export const TICKETING_CONFIG: TicketingConfig = {
    supportTicketCategoryName: 'Support Tickets',
    closedTicketCategoryName: 'Closed Tickets',
    ticketChannelNamePrefix: 'S{{####}}-{{user}}-{{creator}}',
    moderationRoles: ['Moderator', 'Dungeon Master'],
};
