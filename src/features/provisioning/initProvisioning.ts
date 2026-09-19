import { interactionsRegistry } from '../../features-system/commands';
import { handleApplyJourney } from './commands/applyJourneyButton';
import { INSTALL_JOURNEY_APPLY_ID } from './commands/installJourneyCommand';
import { registerJourney } from './journeys/journeyRegistry';
import { ONBOARDING_JOURNEY } from './journeys/onboardingJourney';

/**
 * Wires the provisioning interaction handlers and registers the bundled journeys.
 *
 * Journeys are registered *here* rather than inside the engine, so the engine holds
 * no list of what exists. The one bundled journey is an example that happens to ship;
 * removing this line would leave provisioning working with nothing to install, which
 * is the correct behaviour for a system with no opinion about its content.
 */
export function initProvisioning(): void {
    registerJourney(ONBOARDING_JOURNEY);

    // The apply button carries its journey key in the custom id, so it registers as
    // a dynamic prefix handler rather than an exact match.
    interactionsRegistry.registerDynamic(`${INSTALL_JOURNEY_APPLY_ID}:`, (interaction) =>
        handleApplyJourney(interaction as Parameters<typeof handleApplyJourney>[0])
    );
}
