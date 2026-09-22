export * from './initTicketsFeature';
export * from './commands/deployTicketCommand';

// The surface other features consume. Flows reach in through this barrel rather
// than deep-importing, which keeps the one supported entry point obvious — and
// the dependency is one-directional by design: tickets never import flows.
export * from './ticketService';
export type { TicketEntity, TicketIdentity, TicketStatus, TicketType } from './data/ticketsSchema';
export { TICKET_STATUSES } from './data/ticketsSchema';
export type { TicketingConfig, TicketTypeDefinition } from './data/ticketingSchema';
