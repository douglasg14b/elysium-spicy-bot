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

// Which journey a flow installs. An attachment is a row, not a naming convention, so
// a journey can hold several flows — and every surface that asks the question gets the
// same answer from one place rather than re-deriving it from a key.
export { flowJourneyLinksRepo, FlowJourneyLinksRepo } from './data/flowJourneyLinksRepo';
export type { FlowJourneyLinkEntity } from './data/flowJourneyLinksSchema';
export { resolveFlowJourney } from './logic/resolveFlowJourney';
export type { ResolvedFlowJourney } from './logic/resolveFlowJourney';

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

// Drift. The third question about a binding, after "does it exist" (install) and "may
// I delete it" (teardown): is it still what we said it was. The comparison is pure and
// takes a snapshot rather than a guild, which is what keeps its permission rules — the
// subtle part — testable without one.
export type {
    ResourceDriftKind,
    ResourceDriftReport,
    PermissionDifference,
} from './logic/resourceDrift';
export { describeDrift, hasDrift } from './logic/resourceDrift';
export type { JourneyDriftPlan, UncheckedResource } from './logic/journeyDriftPlan';

// Repair reconciles the guild *to* the declaration, never the other way. An adopted
// resource and a wrong-type binding are both refused rather than repaired — the first
// is the adoption promise, the second needs a decision only the operator can take.
// A resource the journey installed and no longer declares. Not drift — there is no
// declaration left to compare against, so the honest answers are delete or forget
// rather than repair. Until this existed, such an object appeared on no screen at all.
export { findOrphanedBindings, describeOrphan } from './logic/orphanedBindings';
export type { OrphanedBinding } from './logic/orphanedBindings';

export { applyDriftRepair } from './logic/applyDriftRepair';
export type {
    ApplyDriftRepairResult,
    RepairedResource,
    RepairOutcome,
    PermissionOverwriteWrite,
} from './logic/applyDriftRepair';

export type {
    ResourceBindingEntity,
    ResourceBindingState,
} from './data/resourceBindingsSchema';
export { RESOURCE_BINDING_STATES } from './data/resourceBindingsSchema';
