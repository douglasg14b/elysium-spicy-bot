import { interactionsRegistry } from '../../features-system/commands';
import { CreateModTicketButtonComponent, CreateModTicketModalComponent } from './components';

/**
 * Initializes the ticket system event handlers
 */
export function initTicketsFeature(): void {
    interactionsRegistry.register(CreateModTicketButtonComponent().component, CreateModTicketButtonComponent().handler);
    interactionsRegistry.register(CreateModTicketModalComponent().component, CreateModTicketModalComponent().handler);
}
