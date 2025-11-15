import { interactionsRegistry } from '../../features-system/commands';
import {
    CreateModTicketButtonComponent,
    CreateModTicketModalComponent,
    TicketClaimButtonComponent,
    TicketUnclaimButtonComponent,
    TicketCloseButtonComponent,
    TicketDeleteButtonComponent,
    TicketReopenButtonComponent,
    TicketConfigModalComponent,
    TicketConfigButtonComponent,
} from './components';

/**
 * Initializes the ticket system event handlers
 */
export function initTicketsFeature(): void {
    // Register ticket creation components, this doesn't actually consume or use the components themselves
    interactionsRegistry.register(
        CreateModTicketButtonComponent(true).component,
        CreateModTicketButtonComponent(true).handler
    );
    interactionsRegistry.register(CreateModTicketModalComponent().component, CreateModTicketModalComponent().handler);

    // Register ticket configuration components
    interactionsRegistry.register(TicketConfigModalComponent().component(), TicketConfigModalComponent().handler);
    interactionsRegistry.register(TicketConfigButtonComponent().component, TicketConfigButtonComponent().handler);

    // Register ticket action button handlers (using default enabled state for registration)
    interactionsRegistry.register(TicketClaimButtonComponent().component(true), TicketClaimButtonComponent().handler);
    interactionsRegistry.register(
        TicketUnclaimButtonComponent().component(true),
        TicketUnclaimButtonComponent().handler
    );
    interactionsRegistry.register(TicketCloseButtonComponent().component(true), TicketCloseButtonComponent().handler);
    interactionsRegistry.register(TicketDeleteButtonComponent().component(true), TicketDeleteButtonComponent().handler);
    interactionsRegistry.register(TicketReopenButtonComponent().component(true), TicketReopenButtonComponent().handler);
}
