import type { JourneyDeclaration } from '../logic/resourceDeclaration';
import { validateJourneyDeclaration } from '../logic/resourceDeclaration';

/**
 * The journeys this bot can install.
 *
 * Deliberately a registry rather than a hardcoded list inside any one journey's file:
 * the engine has no opinion about what a journey contains, and adding a second one
 * must not mean editing the first. A journey is *data* handed to provisioning, not a
 * concept provisioning knows about.
 */
const registry = new Map<string, JourneyDeclaration>();

/**
 * Add a journey to the installable set.
 *
 * Validates on registration rather than at install time, so a malformed declaration
 * fails at startup — where whoever wrote it is looking — instead of in front of an
 * operator halfway through a plan.
 */
export function registerJourney(journey: JourneyDeclaration): void {
    if (registry.has(journey.journeyKey)) {
        throw new Error(
            `A journey with key "${journey.journeyKey}" is already registered. Journey keys must be unique.`
        );
    }

    validateJourneyDeclaration(journey);
    registry.set(journey.journeyKey, journey);
}

export function getJourney(journeyKey: string): JourneyDeclaration | undefined {
    return registry.get(journeyKey);
}

export function listJourneys(): readonly JourneyDeclaration[] {
    return [...registry.values()];
}

/** Test seam. Not used in production code. */
export function clearJourneyRegistry(): void {
    registry.clear();
}
