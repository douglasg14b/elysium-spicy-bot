/**
 * Shapes returned by the journey routes, the last BrattyBot API routes not in the OpenAPI
 * spec yet. Kept in sync with `src/web/api/*` by hand, and held to it by the `*Drift`
 * tests beside those routes (`provisioningWireDrift`, `driftWireShapeDrift`).
 *
 * The mirror is hand-written because it has to be. A single `import type` from
 * `src/` inside this workspace drags the whole bot tree into `tsc -b` — the first
 * half of `pnpm build:web` — and the build fails.
 *
 * Every other shape comes from `@brattybot/web-sdk`, generated from the server's own
 * schemas. This file goes when the journey routes convert.
 */

/* ------------------------------------------------------------------ *
 * Published inventory, teardown and drift — the journey routes' shapes
 * ------------------------------------------------------------------ */

/** A message in the guild carrying this flow's trigger buttons. */
export interface PublishedButtonMessage {
    channelId: string;
    messageId: string;
    nodeIds: string[];
}

/**
 * A channel or role this flow's journey put in the guild.
 *
 * `refused` means unpublishing will leave it alone — it was adopted rather than
 * created, or it is a category still holding something. `explanation` is why, and is
 * the part a dialog must show rather than bury under a count.
 */
/**
 * Why an unpublish refuses to touch a resource.
 *
 * Mirrors `RefusalReason` in `src/features/provisioning/logic/unpublishPlan.ts`.
 * `adopted` and `category-has-survivors` are the two the dialog groups by, and they
 * mean opposite things about ownership: the first was never ours, the second is ours
 * but now has someone else's channel inside it.
 */
export const REFUSAL_REASONS = [
    'adopted',
    'category-has-survivors',
    'missing-permission',
    'unrecognised-state',
    'interrupted-create',
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export interface PublishedResource {
    resourceKey: string;
    kind: string;
    name: string;
    discordId?: string;
    refused: boolean;
    refusalReason?: RefusalReason;
    explanation?: string;
    /** For `category-has-survivors`: what is still inside, by name. */
    survivors?: string[];
}

/**
 * What a flow — or a journey — currently has live in the guild.
 *
 * Mirrors `publishedBody` in `src/web/api/publishedBody.ts`, which is the one wire shape
 * `GET /flows/:flowId/published` and `GET /journeys/:journeyKey/published` both send.
 * One type rather than two, because the two differ only in **scope**, not in shape: a
 * journey's `buttonMessages` covers every attached flow's messages where a flow's covers
 * its own. Everything reading this — `summarisePublished` and both dialogs — cares about
 * the fields, not about which route filled them, so splitting the type would fork that
 * code for no difference it could act on.
 *
 * `mayHaveUnrecordedButtons` is always true and comes from the server rather than
 * being assumed here: buttons posted before the recording table existed had their
 * message ids thrown away, so nothing can find them. An empty list does not mean
 * nothing is published, and the dialog has to say so.
 */
export interface PublishedFlowState {
    buttonMessages: PublishedButtonMessage[];
    deletableResources: PublishedResource[];
    refusedResources: PublishedResource[];
    mayHaveUnrecordedButtons: boolean;
}

export type UndeployOutcome = 'removed' | 'alreadyGone' | 'failed';

export interface UndeployedButtonMessage {
    channelId: string;
    messageId: string;
    outcome: UndeployOutcome;
    explanation?: string;
}

export type UnpublishOutcome = 'deleted' | 'forgotten' | 'refused' | 'failed';

export interface UnpublishedResource {
    resourceKey: string;
    kind: string;
    name: string;
    outcome: UnpublishOutcome;
    explanation?: string;
}

/**
 * One way a live object no longer matches what its journey declared.
 *
 * Mirrors `DriftDetailBody` in `src/web/api/driftBody.ts`. `kind` is `string` rather
 * than a union for the same reason `PublishedResource.kind` is: a drift kind this build
 * does not recognise must still show its sentence rather than be dropped, and the
 * sentence is written by the server anyway.
 */
export interface DriftDetail {
    kind: string;
    /** Server-authored prose, in Discord markdown. Render through `withEmphasis`. */
    explanation: string;
}

/**
 * A resource that is still declared, still there, and no longer what it was.
 *
 * Mirrors `DriftResourceBody`. `repairable` comes from the server and is **not**
 * inferred from `drift` — adoption is a property of the binding and appears in no drift
 * kind, so a client deriving it would offer a repair the server refuses.
 */
export interface DriftedResource {
    resourceKey: string;
    name: string;
    kind: string;
    drift: DriftDetail[];
    repairable: boolean;
}

/**
 * A resource the journey installed and no longer declares.
 *
 * Mirrors `OrphanBody`. `stillInGuild` and `neverSettled` come apart in the case that
 * matters — a crash between creating an object and settling its row leaves a
 * never-settled record with a live object behind it — so both travel rather than one
 * being derived from the other.
 */
export interface OrphanedResource {
    bindingId: number;
    resourceKey: string;
    kind: string;
    name: string;
    stillInGuild: boolean;
    neverSettled: boolean;
    /** Server-authored prose, in Discord markdown. Render through `withEmphasis`. */
    explanation: string;
}

/** A resource found, but whose permissions could not be compared, and why. */
export interface UncheckedResource {
    resourceKey: string;
    name: string;
    reason: string;
}

/**
 * The answer to "is my server still what I asked for".
 *
 * Mirrors `DriftBody` in `src/web/api/driftBody.ts`. Drift and orphans arrive together
 * because they are one screen: they are different questions, but an operator asking
 * this one is owed both answers at once.
 *
 * `cleanKeys` is carried so the dialog can say "checked 6, 2 drifted" rather than
 * "2 drifted" — the difference between a report an operator trusts and a number they
 * have to go and verify. `unchecked` is a third state beside clean and drifted, and
 * collapsing it into either is a lie in the direction that costs most.
 */
export interface JourneyDrift {
    journeyKey: string;
    drifted: DriftedResource[];
    cleanKeys: string[];
    unchecked: UncheckedResource[];
    orphans: OrphanedResource[];
}

/**
 * What became of one approved repair.
 *
 * Mirrors `REPAIR_OUTCOMES` in `src/features/provisioning/logic/applyDriftRepair.ts`,
 * and it is **three** values, not four. An earlier version of this mirror added a
 * `partiallyRepaired` member because a comment on the server's catch block names one —
 * the comment describes an intent the code does not implement. A partial repair is
 * `failed` carrying a populated `repaired`; see `RepairedResource.repaired`.
 */
export type RepairOutcome = 'repaired' | 'refused' | 'failed';

export interface RepairedResource {
    resourceKey: string;
    kind: string;
    name: string;
    outcome: RepairOutcome;
    /**
     * Which drift kinds were actually put back.
     *
     * Load-bearing on the `failed` path, not just informational: a resource whose
     * rename landed before a later permission write threw comes back as `failed` with
     * this populated, and it is the **only** signal distinguishing that from a repair
     * that changed nothing. Reporting such a resource as a flat failure tells an
     * operator nothing happened to a channel that really was renamed.
     */
    repaired?: string[];
    explanation?: string;
}

/** What forgetting one leftover record did. */
export interface ForgottenOrphan {
    forgotten: boolean;
    resourceKey: string;
    name: string;
    /**
     * Whether the object is still sitting in the server with nothing tracking it.
     *
     * The distinction an operator is owed: forgetting a record behind a live object
     * means something remains that no screen will mention again.
     */
    objectRemains: boolean;
}

/**
 * What kind of guild object a declared resource is.
 *
 * Mirrors `RESOURCE_KINDS` on the server. A closed union, because each value has
 * creation code behind it and an unrecognised kind has nothing to fall back on.
 */
export type ResourceKind = 'category' | 'textChannel' | 'role';

export type PermissionAudience = 'everyone' | 'roles' | 'staff' | 'subject';
export type PermissionAccess = 'hidden' | 'readOnly' | 'readWrite';

export interface PermissionIntent {
    audience: PermissionAudience;
    roleIds?: string[];
    access: PermissionAccess;
}

/**
 * A resource a flow needs, named by a key that is stable across guilds.
 *
 * The key is the identity; `defaultName` is only what the operator sees pre-filled.
 * That separation is what lets a picker offer a channel that does not exist yet.
 */
export interface ResourceDeclaration {
    key: string;
    kind: ResourceKind;
    defaultName: string;
    parentKey?: string;
    permissions?: PermissionIntent[];
    description?: string;
    /**
     * A channel or role that already exists, to adopt instead of creating one.
     *
     * Set when the operator picked something real from the resource picker. Absent is
     * the common case and means "create this". Mirrors the server's own
     * `ResourceDeclaration.adoptDiscordId`; the server's Zod schema is the gate.
     */
    adoptDiscordId?: string;
}

/** A journey with its declarations, from `GET /api/guilds/:guildId/journeys/:key`. */
export interface Journey {
    journeyKey: string;
    name: string;
    description: string | null;
    resources: ResourceDeclaration[];
    createdAt: string;
    updatedAt: string;
}

/**
 * A flow attached to a journey.
 *
 * `name` falls back to the flow id when the flow row has vanished — the server never
 * omits a dangling link, because it is still something that blocks a delete.
 */
export interface AttachedFlow {
    flowId: string;
    name: string;
}

/** List shape — no resource bodies, but the attachments each journey holds. */
export interface JourneySummary {
    journeyKey: string;
    name: string;
    description: string | null;
    resourceCount: number;
    attachedFlows: AttachedFlow[];
    createdAt: string;
    updatedAt: string;
}

/** A resource the moving flow brings with it, and what it is in Discord right now. */
export interface MovingResource {
    key: string;
    kind: ResourceKind;
    declaredName: string;
    /** Non-null only for an installed resource — the thing "leave behind" would orphan. */
    live: { discordId: string; name: string } | null;
}

/** A key both journeys declare, and what each of them means by it. */
export interface KeyCollision {
    key: string;
    movingName: string;
    destinationName: string;
}

/**
 * What dropping one flow onto another would do, from `GET /flows/:flowId/group-preview`.
 *
 * The dialog is built entirely from this. `canMerge` false does not close the dialog —
 * leaving the resources behind is still a legitimate choice — it removes the merge
 * option and names the keys that made it impossible.
 */
export interface GroupPreview {
    /** Null when the target has no journey yet, so one would be created. */
    destination: { journeyKey: string; name: string } | null;
    /** What to call the destination in copy, whether or not it exists yet. */
    destinationName: string;
    movingFlowName: string;
    moving: MovingResource[];
    canMerge: boolean;
    collisions: KeyCollision[];
    /** Live resources that "leave behind" would strand. The loud half of the dialog. */
    orphaned: MovingResource[];
}

/** The operator's answer to a group preview. No default — both outcomes are consequential. */
export type GroupResolution = 'merge' | 'leave';

/**
 * The journey one flow installs, from `GET /flows/:flowId/attachment`.
 *
 * `null` for a flow attached to nothing, which is the normal state of a flow that
 * declares no resources. `sharedWith` is every **other** flow on the same journey, which
 * is what makes "detach" read differently from "detach, and two others still install it".
 */
export interface FlowAttachment {
    journeyKey: string;
    name: string;
    resourceCount: number;
    sharedWith: AttachedFlow[];
}

/**
 * What an attach did.
 *
 * `movedFrom` is set when the flow was already on a different journey. A flow has at
 * most one journey — the unique index on `(guildId, flowId)` says so — making attach a
 * **move**, and the UI has to say that rather than implying the flow now has two.
 */
export interface AttachResult {
    journeyKey: string;
    name: string;
    resourceCount: number;
    movedFrom: { journeyKey: string; name: string } | null;
}

/*
 * The member lists `driftWireShapeDrift.test.ts` compares against `src/web/api/driftBody.ts`.
 *
 * `satisfies` rejects a name that is not a member, and the checks below reject a member
 * missing from the list, so `tsc -b` holds each list to its interface in both directions.
 *
 * Added after the fact, and the reason is worth keeping: `RepairOutcome` was mirrored
 * here with a fourth member — `partiallyRepaired` — that the server has never emitted.
 * The browser filtered for it, always found nothing, and reported every partial repair
 * as a flat failure, telling operators that nothing happened to channels that really
 * had been renamed. Both workspaces typechecked clean throughout, because each compiles
 * only against its own copy of the shape.
 *
 * `REPAIR_OUTCOMES` is gated as a vocabulary rather than a key list, which is the row
 * that would have caught it.
 */
export const REPAIR_OUTCOMES = ['repaired', 'refused', 'failed'] as const;

export const DRIFT_DETAIL_KEYS = [
    'kind',
    'explanation',
] as const satisfies readonly (keyof DriftDetail)[];

export const DRIFT_RESOURCE_KEYS = [
    'resourceKey',
    'name',
    'kind',
    'drift',
    'repairable',
] as const satisfies readonly (keyof DriftedResource)[];

export const ORPHAN_KEYS = [
    'bindingId',
    'resourceKey',
    'kind',
    'name',
    'stillInGuild',
    'neverSettled',
    'explanation',
] as const satisfies readonly (keyof OrphanedResource)[];

export const UNCHECKED_KEYS = [
    'resourceKey',
    'name',
    'reason',
] as const satisfies readonly (keyof UncheckedResource)[];

export const DRIFT_BODY_KEYS = [
    'journeyKey',
    'drifted',
    'cleanKeys',
    'unchecked',
    'orphans',
] as const satisfies readonly (keyof JourneyDrift)[];

/** Fails to compile if a drift wire shape gains a member absent from its list above. */
type DriftKeyListsAreComplete =
    | Exclude<keyof DriftDetail, (typeof DRIFT_DETAIL_KEYS)[number]>
    | Exclude<keyof DriftedResource, (typeof DRIFT_RESOURCE_KEYS)[number]>
    | Exclude<keyof OrphanedResource, (typeof ORPHAN_KEYS)[number]>
    | Exclude<keyof UncheckedResource, (typeof UNCHECKED_KEYS)[number]>
    | Exclude<keyof JourneyDrift, (typeof DRIFT_BODY_KEYS)[number]>;

/** Do not delete as unused: removing it erases the guard above. */
const driftKeyListsAreComplete: [DriftKeyListsAreComplete] extends [never]
    ? true
    : ['A drift wire-shape key list is missing', DriftKeyListsAreComplete] = true;

void driftKeyListsAreComplete;
