/*
 * The vocabularies (`RESOURCE_KINDS`, `PERMISSION_AUDIENCES`, `PERMISSION_ACCESS_LEVELS`,
 * `REPAIR_OUTCOMES`, `RESOURCE_DRIFT_KINDS`) come from the modules that define them rather
 * than through the provisioning barrel: `z.enum` reads them while this module loads, and
 * route tests mock the barrel down to the functions they exercise.
 */
import { z } from '@hono/zod-openapi';
import type { JourneyEntity } from '../../features/provisioning/data/journeysSchema';
import { REPAIR_OUTCOMES, type RepairedResource } from '../../features/provisioning/logic/applyDriftRepair';
import { DECLARED_ROLE_PREFIX } from '../../features/provisioning/logic/declaredRoleReference';
import type { JourneyMergePlan, KeyCollision, MovingResource } from '../../features/provisioning/logic/journeyMergePlan';
import {
    PERMISSION_ACCESS_LEVELS,
    PERMISSION_AUDIENCES,
    type PermissionIntent,
} from '../../features/provisioning/logic/permissionIntent';
import { RESOURCE_KINDS, type ResourceDeclaration } from '../../features/provisioning/logic/resourceDeclaration';
import { RESOURCE_DRIFT_KINDS } from '../../features/provisioning/logic/resourceDrift';
import { normaliseResourceName } from '../../features/provisioning/logic/resourceName';
import {
    errorBodyResponse,
    GUILD_SCOPED_ERRORS,
    GuildPathSchema,
    type ChecksHold,
    type MismatchedChecks,
    type SchemaMatches,
} from './openApi';

/**
 * What the journey routes receive and send: a journey, the resources it declares, a flow's
 * attachment to one, grouping two flows, and repairing drift.
 *
 * Schemas, as in `flowBody.ts`: each is what its route declares and what the dashboard SDK
 * is generated from, and the `.openapi('Name')` ids are the names the dashboard imports by.
 * Domain types sent as they are stay where they live and are held to their schema both
 * ways by {@link SchemaMatches}; bodies built here are typed by `z.infer`.
 *
 * Request rules state only what the browser can check from the spec. Two journey rules
 * cannot be stated that way and are not: whether a `roles` permission names a role (a
 * cross-field rule, {@link rolesWithoutIdsRefusal}, which the handlers ask), and everything
 * `validateJourneyDeclaration` asks of the whole list (duplicate keys, parents, role
 * references), which the repo asks on every write.
 */

/** The key pattern's body, shared by the key rule and the declared-role reference rule. */
const RESOURCE_KEY_PATTERN = '[a-z0-9]+(-[a-z0-9]+)*';

/**
 * A resource key, constrained to what is safe to embed in a Discord custom_id and
 * readable in a diagnostic: lowercase, digits, hyphens.
 *
 * Restrictive on purpose. The key appears in `resource_bindings`, in node configs,
 * and in button custom_ids which Discord caps at 100 characters — permitting
 * arbitrary text would push the failure to whichever of those hit its limit first,
 * long after the operator typed it.
 */
const resourceKeySchema = z
    .string()
    .min(1, 'Give the resource a key.')
    .max(64, 'Resource keys cap at 64 characters.')
    .regex(
        new RegExp(`^${RESOURCE_KEY_PATTERN}$`),
        'Resource keys use lowercase letters, numbers and single hyphens (for example `qa-channel`).'
    );

/** `DECLARED_ROLE_PREFIX`, escaped for use inside a pattern. */
const DECLARED_ROLE_PREFIX_PATTERN = DECLARED_ROLE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One entry in a permission's `roleIds`: a Discord snowflake, or a reference to a
 * role this journey declares.
 *
 * A reference is `resource:<key>` — the key of a role the same journey creates, which
 * has no snowflake until install. Both are strings in the same array, made disjoint
 * by the prefix rather than by assuming ids stay numeric.
 *
 * Only the *shape* is checked here. Whether the referenced key is actually declared
 * is `validateJourneyDeclaration`'s job, because it is the only thing holding the
 * whole journey and can therefore answer it.
 *
 * **One pattern, so the browser can run it.** This was a `.refine()` over
 * `parseDeclaredRoleReference`: an entry without the prefix passes, and one with it
 * passes when the rest is a valid key. The pattern says exactly that — anything not
 * starting with the prefix (`[\s\S]`, so a newline is not refused where the refine took
 * it), or the prefix followed by a key — built from the same prefix and key pattern, so
 * neither is written twice. It accepts the empty string so that an empty entry is refused
 * by `min(1)` alone, as before. `journeyRoleIdRuleParity.test.ts` holds the former refine,
 * this rule and the browser's generated copy to one table.
 */
export const PermissionRoleIdSchema = z
    .string()
    .min(1)
    .regex(
        new RegExp(
            `^(?:(?!${DECLARED_ROLE_PREFIX_PATTERN})[\\s\\S]*|${DECLARED_ROLE_PREFIX_PATTERN}${RESOURCE_KEY_PATTERN})$`
        ),
        'A declared role reference must name a valid resource key (lowercase letters, numbers and single hyphens).'
    );

/** What kind of guild object a declared resource is. */
const ResourceKindSchema = z.enum(RESOURCE_KINDS).openapi('ResourceKind');

/** Who a permission intent is about. `roles` names its roles in `roleIds`. */
const PermissionAudienceSchema = z.enum(PERMISSION_AUDIENCES).openapi('PermissionAudience');

/** What that audience may do. */
const PermissionAccessSchema = z.enum(PERMISSION_ACCESS_LEVELS).openapi('PermissionAccess');

/**
 * One row of a resource's permission grid: this audience gets this access.
 *
 * A `roles` audience must name at least one role. That rule spans two fields, so the
 * spec cannot carry it to the browser; the routes ask {@link rolesWithoutIdsRefusal} once
 * this schema has passed.
 */
const PermissionIntentSchema = z
    .object({
        audience: PermissionAudienceSchema,
        roleIds: z.array(PermissionRoleIdSchema).readonly().optional(),
        access: PermissionAccessSchema,
    })
    .openapi('PermissionIntent', {
        description:
            'This audience gets this access. `roleIds` names the roles for a `roles` audience — a ' +
            'snowflake, or `resource:<key>` for a role the same journey declares — and must not be ' +
            'empty there.',
    });

/**
 * A Discord snowflake, as the id of something being adopted.
 *
 * Shape-checked here and nowhere else in the request path. Whether the id names
 * anything real is a question only the guild can answer, and it is asked at plan
 * time (`buildInstallPlan`) and again at apply time (`requireAdoptable`) — a channel
 * can be deleted between declaring it and installing, so a save-time existence check
 * would be a guarantee that expires. What this *can* stop is a non-id reaching the
 * plan, where it would surface as "this channel does not exist" and send the operator
 * looking for a deletion that never happened.
 */
const discordIdSchema = z.string().regex(/^\d{17,20}$/, 'A channel or role id is 17 to 20 digits.');

/**
 * A resource a journey declares, as every route sends and receives it.
 *
 * Exported for the chip-agreement and resource-name tests, which drive it directly.
 * Nothing else should import it — the routes are its callers.
 *
 * The transform stores the name Discord will hold, so the declaration never disagrees
 * with the channel it installs. Normalised rather than rejected: journeys saved before
 * this rule carry names like `Welcome Mat`, and refusing them would 400 the operator's
 * next unrelated save of that journey — they get fixed on it instead. The panel already
 * normalises as the operator types, so a browser save is unchanged by this; it is here
 * because the browser is a client, not the authority. The spec describes the object the
 * transform reads, which is also the shape it writes.
 */
export const ResourceDeclarationSchema = z
    .object({
        key: resourceKeySchema,
        kind: ResourceKindSchema,
        defaultName: z.string().min(1, 'Give the resource a name.').max(100, 'Resource names cap at 100 characters.'),
        parentKey: resourceKeySchema.optional(),
        permissions: z.array(PermissionIntentSchema).readonly().optional(),
        description: z.string().max(500, 'Descriptions cap at 500 characters.').optional(),
        /** Set when the operator picked something that already exists instead of declaring a new one. */
        adoptDiscordId: discordIdSchema.optional(),
    })
    .transform((resource) => ({
        ...resource,
        defaultName: normaliseResourceName(resource.kind, resource.defaultName),
    }))
    .openapi('ResourceDeclaration', {
        description:
            'A resource a journey needs, named by a key stable across servers. `defaultName` is ' +
            'stored as Discord will hold it: a text channel lowercased, whitespace hyphenated. ' +
            '`adoptDiscordId` adopts something that already exists instead of creating it.',
    });

const ResourceDeclarationsSchema = z.array(ResourceDeclarationSchema).readonly();

/** What a flow declares, as both its resource routes answer: the read and the save. */
export const FlowResourcesSchema = z.object({ resources: ResourceDeclarationsSchema });

/**
 * Why a list of declarations is refused for a `roles` permission naming no role, or
 * `undefined` when none does.
 *
 * Asked by every route that takes resources, straight after its body schema passes — so
 * still a 400 ahead of any lookup, as it was when it was a `.refine()` on the schema. It
 * moved here because it reads two fields of one intent, which the spec cannot express and
 * the browser therefore could not be given; the request-rule emit refuses a `.refine()`
 * for exactly that reason. The browser warns about the same thing with its
 * `ruleNamesNoRole` chip.
 *
 * `roles` without ids compiles to an error deep inside the applier at install time.
 * Rejecting it at save time blames the field the operator can actually fix.
 */
export function rolesWithoutIdsRefusal(resources: readonly ResourceDeclaration[]): string | undefined {
    const namesNoRole = resources.some((resource) =>
        resource.permissions?.some((intent) => intent.audience === 'roles' && !intent.roleIds?.length)
    );
    return namesNoRole ? 'A `roles` permission must name at least one role.' : undefined;
}

/** The path of every route about one journey. */
export const JourneyPathSchema = GuildPathSchema.extend({
    journeyKey: z.string(),
});

/**
 * The path of the orphan-forget route. `bindingId` is checked by the handler as text, not
 * here: its refusal is one fixed sentence whatever was wrong with it, which no pair of
 * rules here could give.
 */
export const OrphanPathSchema = JourneyPathSchema.extend({
    bindingId: z.string(),
});

const journeyNameSchema = z.string().min(1, 'Give the journey a name.').max(100, 'Journey names cap at 100 characters.');

const journeyDescriptionSchema = z.string().max(500, 'Descriptions cap at 500 characters.');

/** The body of `POST /journeys`. */
export const JourneyCreateSchema = z
    .object({
        journeyKey: resourceKeySchema,
        name: journeyNameSchema,
        description: journeyDescriptionSchema.optional(),
        resources: z.array(ResourceDeclarationSchema),
    })
    .openapi('JourneyCreate');

/** The body of `PUT /journeys/{journeyKey}`: send only what changed. The key is identity and never changes. */
export const JourneyUpdateSchema = z
    .object({
        name: journeyNameSchema.optional(),
        description: journeyDescriptionSchema.nullable().optional(),
        resources: z.array(ResourceDeclarationSchema).optional(),
    })
    .openapi('JourneyUpdate', {
        description:
            'A partial update: send only what changed. `description: null` clears it. `resources` ' +
            'replaces the whole list.',
    });

/** The body of `PUT /flows/{flowId}/resources`: the whole list, an empty one removing the flow's journey. */
export const FlowResourcesSaveSchema = z
    .object({
        resources: z.array(ResourceDeclarationSchema),
    })
    .openapi('FlowResourcesSave');

/** The body of `POST /flows/{flowId}/attach`. */
export const FlowAttachSchema = z
    .object({
        journeyKey: resourceKeySchema,
    })
    .openapi('FlowAttach');

/**
 * Which drifted resources the operator ticked.
 *
 * Keys rather than the reviewed report, because the report is rebuilt server-side —
 * see the route. `min(1)` because an empty repair is a request that cannot have been
 * meant: the button is only reachable with something selected, so an empty array is a
 * malformed client rather than an operator who chose nothing, and silently returning
 * "repaired 0" would hide that.
 *
 * Exported for the route test that asserts a forged `approvedPlan` is stripped here
 * rather than merely ignored downstream. That distinction is not observable through
 * the handler — see the test — so the schema is checked directly.
 */
export const DriftRepairSchema = z
    .object({
        resourceKeys: z.array(resourceKeySchema).min(1, 'Choose at least one resource to repair.'),
    })
    .openapi('DriftRepair');

/** The operator's answer to a group preview. No default — both outcomes are consequential. */
const GroupResolutionSchema = z.enum(['merge', 'leave']).openapi('GroupResolution');

/**
 * What the flows page sends when a row is dropped onto another.
 *
 * `resolution` has no default on purpose. Omitting it is only legal when the moving flow
 * declares nothing — the silent, common case — and any other omission is a 400 rather
 * than an assumed answer, because both outcomes are consequential and one of them
 * abandons live channels.
 *
 * The new journey's key is supplied by the client, which already derives a unique slug
 * for the attach modal. Validated here against the same shape every other key uses, so
 * a hand-rolled request cannot conjure one the rest of the system could not store.
 */
export const FlowGroupSchema = z
    .object({
        targetFlowId: z.string().min(1, 'Name the flow being grouped with.'),
        resolution: GroupResolutionSchema.optional(),
        newJourneyKey: resourceKeySchema.optional(),
        newJourneyName: journeyNameSchema.optional(),
    })
    .openapi('FlowGroup', {
        description:
            '`resolution` is required when the moving flow declares resources. `newJourneyKey` is ' +
            'required when the target flow is on no journey yet, so one is created.',
    });

/** A journey with its declarations. */
export const JourneySchema = z
    .object({
        journeyKey: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        resources: ResourceDeclarationsSchema,
        createdAt: z.string(),
        updatedAt: z.string(),
    })
    .openapi('Journey');

/**
 * A flow attached to a journey. `name` falls back to the flow id when the flow row has
 * vanished — a dangling link is never omitted, because it still blocks a delete.
 */
const AttachedFlowSchema = z
    .object({
        flowId: z.string(),
        name: z.string(),
    })
    .openapi('AttachedFlow');

/**
 * The list shape: metadata, a count, and **which flows are attached**.
 *
 * The attachments are what make a journey legible as a shared thing rather than a row
 * with a key. They are also what an operator needs before pressing delete, since that is
 * refused while anything is attached — showing the names on the row means the refusal
 * confirms something already on screen rather than being the first they hear of it.
 */
export const JourneySummarySchema = z
    .object({
        journeyKey: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        resourceCount: z.number(),
        attachedFlows: z.array(AttachedFlowSchema).readonly(),
        createdAt: z.string(),
        updatedAt: z.string(),
    })
    .openapi('JourneySummary', {
        description: 'One journey, without its declarations, and the flows attached to it.',
    });

/** A flow attached to a journey, as the list reports it. */
export type AttachedFlowBody = z.infer<typeof AttachedFlowSchema>;

/**
 * The journey one flow installs. `sharedWith` is every **other** flow on it, which is what
 * makes "detach" read differently from "detach, and two others still install it".
 */
export const FlowAttachmentSchema = z
    .object({
        journeyKey: z.string(),
        name: z.string(),
        resourceCount: z.number(),
        sharedWith: z.array(AttachedFlowSchema),
    })
    .openapi('FlowAttachment');

/**
 * What a detach did. `detached` is false when the flow was on no journey — the state asked
 * for, so not an error.
 */
export const DetachResultSchema = z
    .object({
        detached: z.boolean(),
    })
    .openapi('DetachResult');

/** A journey named by its key, for an answer that says which one. */
const journeyReferenceSchema = z.object({
    journeyKey: z.string(),
    name: z.string(),
});

/**
 * What an attach did. `movedFrom` is set when the flow was on another journey: a flow has
 * at most one, so attaching is a **move**, and the UI says which journey was left.
 */
export const AttachResultSchema = z
    .object({
        journeyKey: z.string(),
        name: z.string(),
        resourceCount: z.number(),
        movedFrom: journeyReferenceSchema.nullable(),
    })
    .openapi('AttachResult');

/** What grouping did: the journey both flows now sit in. */
export const FlowGroupResultSchema = z
    .object({
        journeyKey: z.string(),
        name: z.string(),
        resourceCount: z.number(),
    })
    .openapi('FlowGroupResult');

/** A resource the moving flow brings with it, and what it is in Discord right now. */
const MovingResourceSchema = z
    .object({
        key: z.string(),
        kind: ResourceKindSchema,
        declaredName: z.string(),
        /** Non-null only for an installed resource — the thing "leave behind" would orphan. */
        live: z.object({ discordId: z.string(), name: z.string() }).nullable(),
    })
    .openapi('MovingResource');

/** A key both journeys declare, and what each of them means by it. */
const KeyCollisionSchema = z
    .object({
        key: z.string(),
        movingName: z.string(),
        destinationName: z.string(),
    })
    .openapi('KeyCollision');

/** `planJourneyMerge`'s answer, which the preview sends as it is. Not a component of its own. */
const journeyMergePlanSchema = z.object({
    moving: z.array(MovingResourceSchema).readonly(),
    canMerge: z.boolean(),
    collisions: z.array(KeyCollisionSchema).readonly(),
    orphaned: z.array(MovingResourceSchema).readonly(),
});

/**
 * What dropping one flow onto another would do. The dialog is built entirely from this.
 * `canMerge` false does not close the dialog — leaving the resources behind is still a
 * legitimate choice — it removes the merge option and names the keys that made it so.
 */
export const GroupPreviewSchema = journeyMergePlanSchema
    .extend({
        /** Null when the target has no journey yet — one would be created. */
        destination: journeyReferenceSchema.nullable(),
        /** What to call the destination in copy, whether or not it exists yet. */
        destinationName: z.string(),
        movingFlowName: z.string(),
    })
    .openapi('GroupPreview', {
        description:
            'What grouping would do. `destination` is null when the target flow is on no journey ' +
            'yet, so one would be created. `orphaned` are the live resources "leave" would strand.',
    });

/**
 * What became of one approved repair. A partial repair is `failed` carrying a populated
 * `repaired` — the only signal that a resource really was changed before the step that
 * failed — not an outcome of its own.
 */
const RepairedResourceSchema = z
    .object({
        resourceKey: z.string(),
        kind: ResourceKindSchema,
        name: z.string(),
        outcome: z.enum(REPAIR_OUTCOMES),
        repaired: z.array(z.enum(RESOURCE_DRIFT_KINDS)).readonly().optional(),
        explanation: z.string().optional(),
    })
    .openapi('RepairedResource');

/**
 * Each schema above that states a domain type the routes send as it is, against that type.
 * Gathered here so `__tests__/journeyBody.test-d.ts` can assert them; see {@link SchemaMatches}.
 */
type JourneyBodyChecks = ChecksHold<{
    PermissionIntent: SchemaMatches<typeof PermissionIntentSchema, PermissionIntent>;
    ResourceDeclaration: SchemaMatches<typeof ResourceDeclarationSchema, ResourceDeclaration>;
    MovingResource: SchemaMatches<typeof MovingResourceSchema, MovingResource>;
    KeyCollision: SchemaMatches<typeof KeyCollisionSchema, KeyCollision>;
    JourneyMergePlan: SchemaMatches<typeof journeyMergePlanSchema, JourneyMergePlan>;
    RepairedResource: SchemaMatches<typeof RepairedResourceSchema, RepairedResource>;
}>;

/** The checks in {@link JourneyBodyChecks} that fail, or `never`. Asserted `never` in `__tests__/journeyBody.test-d.ts`. */
export type JourneyBodyMismatch = MismatchedChecks<JourneyBodyChecks>;

export const RepairResultSchema = z
    .object({
        results: z.array(RepairedResourceSchema).readonly(),
    })
    .openapi('RepairResult');

/**
 * What forgetting one leftover record did. `objectRemains` is the distinction an operator
 * is owed: forgetting a record behind a live object leaves something in their server that
 * no screen will mention again.
 */
export const ForgottenOrphanSchema = z
    .object({
        forgotten: z.literal(true),
        resourceKey: z.string(),
        name: z.string(),
        objectRemains: z.boolean(),
    })
    .openapi('ForgottenOrphan');

/** The 404 of a route that looks the journey up first. */
export const JOURNEY_NOT_FOUND = errorBodyResponse('The bot is not in this server, or the journey is not in it.');

/** A route about one journey that reads no body. Not `as const`: see `openApi.ts`. */
export const JOURNEY_ERRORS = {
    ...GUILD_SCOPED_ERRORS,
    404: JOURNEY_NOT_FOUND,
};

/** A stored journey as the routes send it. */
export function journeyDetail(journey: JourneyEntity): z.infer<typeof JourneySchema> {
    return {
        journeyKey: journey.journeyKey,
        name: journey.name,
        description: journey.description,
        resources: journey.resources,
        createdAt: new Date(journey.createdAt).toISOString(),
        updatedAt: new Date(journey.updatedAt).toISOString(),
    };
}

/** A stored journey as one row of the list, with the flows attached to it. */
export function journeySummary(
    journey: JourneyEntity,
    attachedFlows: readonly AttachedFlowBody[]
): z.infer<typeof JourneySummarySchema> {
    return {
        journeyKey: journey.journeyKey,
        name: journey.name,
        description: journey.description,
        resourceCount: journey.resources.length,
        attachedFlows,
        createdAt: new Date(journey.createdAt).toISOString(),
        updatedAt: new Date(journey.updatedAt).toISOString(),
    };
}
