export * from './initTicketsFeature';
export * from './commands/deployTicketCommand';
export * from './commands/ticketCommands';

// The surface other features consume. Flows reach in through this barrel rather
// than deep-importing, which keeps the one supported entry point obvious — and
// the dependency is one-directional by design: tickets never import flows.
export * from './ticketService';
export type { TicketEntity, TicketStatus, TicketType } from './data/ticketsSchema';
export { TICKET_STATUSES, TICKET_TYPES } from './data/ticketsSchema';
