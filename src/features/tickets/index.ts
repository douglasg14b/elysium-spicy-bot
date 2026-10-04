export * from './initTicketsFeature';
export * from './commands/deployTicketCommand';

// The surface other features consume. Flows reach in through this barrel rather
// than deep-importing, which keeps the one supported entry point obvious — and
// the dependency is one-directional by design: tickets never import flows.
export * from './ticketService';
// What the service announces after a change commits, and the seam a consumer registers on.
export {
    registerTicketSubscriber,
    TICKET_CHANGE_KINDS,
    type TicketChange,
    type TicketChangeEvent,
    type TicketChangeKind,
    type TicketChangeSubscriber,
} from './ticketChanges';
export { TICKET_VARIABLES } from './logic/ticketVariables';
export type { TicketEntity, TicketIdentity, TicketStatus, TicketType } from './data/ticketsSchema';
export { TICKET_STATUSES } from './data/ticketsSchema';
export type { TicketingConfig, TicketTypeDefinition } from './data/ticketingSchema';
