import type { FeatureGuide } from '../../shared/featureGuide';
import { deployTicketSystemCommand } from './commands/deployTicketCommand';

export const TICKETS_GUIDE: FeatureGuide = {
    name: 'Tickets',
    summary: 'Private channels between a member and the moderators.',
    about: `A ticket is a private channel between a member and the moderators. Staff open one about a member from the ticket panel (posted with /deploy-ticket-system), or a flow opens one (verification, say). Each ticket's channel moves between the Open, Claimed and Closed categories as staff claim, close, reopen or delete it. Ticket types (support, verification and any the server adds) set the channel's name and who can see and write in it, and whether opening one claims it. Both ticket types and moderation roles (who handles tickets — a separate list from the server's staff roles) are edited on the Tickets config page, along with the three categories — the server's, and any a ticket type has of its own, which win for that type.`,
    dashboardPages: [
        { path: '/tickets', label: 'Tickets' },
        { path: '/tickets/config', label: 'Tickets config' },
    ],
    commands: [deployTicketSystemCommand],
};
