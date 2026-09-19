// The provisioning surface other features consume.
//
// Provisioning is a base capability, like ticketing: it must not import anything
// under `src/features/flows/`. Flows (and commands, and the web API) reach in
// through this barrel, and the dependency stays one-directional by design.
export * from './provisioningService';
export { initProvisioning } from './initProvisioning';
export { buildInstallJourneyCommand, handleInstallJourney } from './commands/installJourneyCommand';

// The registry is the supported way to add a journey. The engine ships no journeys of
// its own; what is installable is whatever a consumer registers.
export { registerJourney, getJourney, listJourneys } from './journeys/journeyRegistry';
export { journeyNeedsSubject, journeyNeedsStaffRoles } from './logic/resourceDeclaration';

// An example declaration, exported so it can be referenced and tested. Nothing in the
// engine depends on it.
export {
    ONBOARDING_JOURNEY,
    ONBOARDING_JOURNEY_KEY,
    ONBOARDING_RESOURCE_KEYS,
} from './journeys/onboardingJourney';

export type {
    JourneyDeclaration,
    ResourceDeclaration,
    ResourceKind,
} from './logic/resourceDeclaration';
export { RESOURCE_KINDS, validateJourneyDeclaration } from './logic/resourceDeclaration';

export type { PermissionIntent, PermissionAudience, PermissionAccess } from './logic/permissionIntent';
export { PERMISSION_AUDIENCES, PERMISSION_ACCESS_LEVELS } from './logic/permissionIntent';

export type { InstallPlan, PlanItem, PlanAction, ResourceChoice } from './logic/installPlan';
export { isPlanApplicable } from './logic/installPlan';

export type { AppliedResource, ApplyInstallPlanResult } from './logic/applyInstallPlan';

export type {
    ResourceBindingEntity,
    ResourceBindingState,
} from './data/resourceBindingsSchema';
export { RESOURCE_BINDING_STATES } from './data/resourceBindingsSchema';
