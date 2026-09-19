import { interactionsRegistry } from '../../features-system/commands';
import { handleApplyJourney } from './commands/applyJourneyButton';
import { INSTALL_JOURNEY_APPLY_ID } from './commands/installJourneyCommand';

/**
 * Wires the provisioning interaction handlers.
 *
 * Registers no journeys, and there is no longer anywhere it could. Journeys are rows
 * in the `journeys` table, authored per guild through the dashboard — the bot ships
 * with none, and a fresh install has none until an operator creates one. That is the
 * difference between an engine with no opinion about which journey ships and one an
 * operator can actually add a journey to.
 */
export function initProvisioning(): void {
    // The apply button carries its journey key in the custom id, so it registers as
    // a dynamic prefix handler rather than an exact match.
    interactionsRegistry.registerDynamic(`${INSTALL_JOURNEY_APPLY_ID}:`, (interaction) =>
        handleApplyJourney(interaction as Parameters<typeof handleApplyJourney>[0])
    );
}
