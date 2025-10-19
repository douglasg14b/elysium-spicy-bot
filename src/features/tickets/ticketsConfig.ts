export type TicketingConfig = {
    supportTicketCategoryName: string;
    ticketChannelNamePrefix: string;
    moderationRoles: string[];
};

// TODO: Hardcoded for now, probably should be configurable later
export const TICKETING_CONFIG: TicketingConfig = {
    supportTicketCategoryName: 'Support Tickets',
    ticketChannelNamePrefix: 'S{{####}}-{{user}}-{{creator}}',
    moderationRoles: ['Moderator', 'Dungeon Master'],
};
