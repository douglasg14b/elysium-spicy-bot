import { registerTicketTypeProvider, type TicketTypeProvider } from '../../provisioning';
import { ticketingRepo } from '../data/ticketingRepo';
import { isTicketingConfigConfigured } from '../data/ticketingSchema';
import { createTicketTypeIfAbsent } from './setTicketTypes';
import { listTicketTypes } from './ticketTypes';

/**
 * The ticket feature's side of provisioning's ticket type hook.
 *
 * A journey may declare a ticket type, and install asks through this whether one of that
 * key exists and creates it if not. Provisioning defines the hook (`ticketTypeProvider.ts`)
 * and imports nothing of tickets at run time; this registers the implementation.
 *
 * The sentences an operator reads are this feature's, so provisioning never has to know
 * that the fix for "no ticket settings" is `/deploy-ticket-system`.
 */

const NO_TICKET_SETTINGS =
    "This server has no ticket settings yet, so this journey's ticket type has nowhere to go. " +
    'Deploy the ticket system with `/deploy-ticket-system` first, then install again.';

const NOT_FULLY_SET_UP =
    "The ticket system isn't fully set up yet, so this journey's tickets can't open until it is — " +
    'it still needs its panel deployed, all three categories linked and a moderation role.';

export const ticketTypeProvisioning: TicketTypeProvider = {
    async read(guildId) {
        const entity = await ticketingRepo.get(guildId);
        if (!entity?.config) return { status: 'no-config', blockedReason: NO_TICKET_SETTINGS };

        const ready = isTicketingConfigConfigured(entity);
        return {
            status: 'ok',
            ready,
            notReadyNote: ready ? null : NOT_FULLY_SET_UP,
            types: new Map(listTicketTypes(entity.config).map((type) => [type.type, { label: type.label }] as const)),
        };
    },

    async createIfAbsent(guildId, key, label, settings) {
        // Picked member by member rather than spread, so nothing else a stored
        // declaration happened to carry can reach the ticket config.
        const result = await createTicketTypeIfAbsent(guildId, {
            type: key,
            label,
            nameTemplate: settings.nameTemplate,
            permissions: settings.permissions,
            autoClaimOnOpen: settings.autoClaimOnOpen,
        });

        switch (result.outcome) {
            case 'created':
                return { outcome: 'created' };
            case 'exists':
                return { outcome: 'exists', label: result.label };
            case 'refused':
                return { outcome: 'refused', message: result.message };
        }
    },
};

/**
 * Register {@link ticketTypeProvisioning} with provisioning.
 *
 * Standalone rather than folded into `initTicketsFeature`'s body, because the dashboard
 * boot (`web/e2e/support/bootBot.ts`, which the preview server also runs) copies init by
 * hand and must make the same call. `ticketTypeProvisioningIsWired.test.ts` asserts every
 * boot root does.
 */
export function registerTicketTypeProvisioning(): void {
    registerTicketTypeProvider(ticketTypeProvisioning);
}
