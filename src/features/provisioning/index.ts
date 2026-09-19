// The provisioning surface other features consume.
//
// Provisioning is a base capability, like ticketing: it must not import anything
// under `src/features/flows/`. Flows (and commands, and the web API) reach in
// through this barrel, and the dependency stays one-directional by design.
export * from './provisioningService';

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
