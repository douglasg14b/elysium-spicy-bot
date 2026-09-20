// The provisioning surface other features consume.
//
// Provisioning is a base capability, like ticketing: it must not import anything
// under `src/features/flows/`. Flows (and commands, and the web API) reach in
// through this barrel, and the dependency stays one-directional by design.
export * from './provisioningService';

// Journeys are rows, scoped to a guild. The engine ships none of its own: what is
// installable is whatever an operator has authored for that server.
export { getJourney, listJourneys } from './journeys/journeySource';
export { journeyNeedsSubject, journeyNeedsStaffRoles } from './logic/resourceDeclaration';

// Where an install writes the ids it creates. Registered by whichever feature
// consumes resource keys; provisioning deliberately does not know who that is.
export {
    registerResourceWriteBack,
    clearResourceWriteBack,
    runResourceWriteBack,
} from './resourceWriteBack';
export type { ResourceWriteBack, ResourceWriteBackResult } from './resourceWriteBack';

export { journeysRepo, JourneysRepo, DuplicateJourneyKeyError } from './data/journeysRepo';
export type { JourneyEntity } from './data/journeysSchema';

export type {
    JourneyDeclaration,
    ResourceDeclaration,
    ResourceKind,
} from './logic/resourceDeclaration';
export { RESOURCE_KINDS, validateJourneyDeclaration } from './logic/resourceDeclaration';

export type { PermissionIntent, PermissionAudience, PermissionAccess } from './logic/permissionIntent';
export { PERMISSION_AUDIENCES, PERMISSION_ACCESS_LEVELS } from './logic/permissionIntent';

// How a permission names a role the journey itself creates, rather than one that
// already exists. The prefix is mirrored in the browser; a test holds them equal.
export {
    DECLARED_ROLE_PREFIX,
    declaredRoleReference,
    parseDeclaredRoleReference,
} from './logic/declaredRoleReference';

export type { InstallPlan, PlanItem, PlanAction, ResourceChoice } from './logic/installPlan';
export { isPlanApplicable } from './logic/installPlan';

// The whole install sequence — rebuild, re-check, apply, write back — as one call.
// Every surface that offers an install goes through this, so the steps cannot be
// half-remembered by a second copy. The dashboard's install route is the only caller
// now that the Discord command is retired; the seam stays because the steps are the
// contract, not because a second surface is expected.
export { runInstall } from './logic/runInstall';
export type { InstallRunOutcome, RunInstallInput } from './logic/runInstall';

export type { AppliedResource, ApplyInstallPlanResult } from './logic/applyInstallPlan';

// Teardown. The rule the whole surface rests on lives in `buildUnpublishPlan`: only a
// `created` binding may be deleted from the guild, and a category holding anything this
// run is not already deleting is refused rather than cascaded.
export type {
    UnpublishPlan,
    UnpublishItem,
    UnpublishAction,
    RefusalReason,
} from './logic/unpublishPlan';
export { plannedDeletions, plannedRefusals } from './logic/unpublishPlan';
export type {
    ApplyUnpublishPlanResult,
    UnpublishedResource,
    UnpublishOutcome,
} from './logic/applyUnpublishPlan';

export type {
    ResourceBindingEntity,
    ResourceBindingState,
} from './data/resourceBindingsSchema';
export { RESOURCE_BINDING_STATES } from './data/resourceBindingsSchema';
