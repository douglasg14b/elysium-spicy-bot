import { interactionsRegistry } from '../../features-system/commands';
import { handleApplyJourney } from './commands/applyJourneyButton';
import { INSTALL_JOURNEY_APPLY_ID } from './commands/installJourneyCommand';

/**
 * Wires the provisioning interaction handlers.
 *
 * The apply button carries its journey key in the custom id, so it registers as a
 * dynamic prefix handler rather than an exact match.
 */
export function initProvisioning(): void {
    interactionsRegistry.registerDynamic(`${INSTALL_JOURNEY_APPLY_ID}:`, (interaction) =>
        handleApplyJourney(interaction as Parameters<typeof handleApplyJourney>[0])
    );
}
