import { interactionsRegistry } from '../../features-system/commands';
import {
    CreateModTicketButtonComponent,
    CreateModTicketModalComponent,
    TicketClaimButtonComponent,
    TicketCloseButtonComponent,
    TicketDeleteButtonComponent,
    TicketReopenButtonComponent,
} from './components';

/**
 * Initializes the ticket system event handlers
 */
export function initTicketsFeature(): void {
    // Register ticket creation components
    interactionsRegistry.register(CreateModTicketButtonComponent().component, CreateModTicketButtonComponent().handler);
    interactionsRegistry.register(CreateModTicketModalComponent().component, CreateModTicketModalComponent().handler);

    // Register ticket action button handlers (using default enabled state for registration)
    interactionsRegistry.register(TicketClaimButtonComponent().component(true), TicketClaimButtonComponent().handler);
    interactionsRegistry.register(TicketCloseButtonComponent().component(true), TicketCloseButtonComponent().handler);
    interactionsRegistry.register(TicketDeleteButtonComponent().component(true), TicketDeleteButtonComponent().handler);
    interactionsRegistry.register(TicketReopenButtonComponent().component(true), TicketReopenButtonComponent().handler);
}
