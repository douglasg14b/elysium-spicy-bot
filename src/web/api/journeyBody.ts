/*
 * The vocabularies (`RESOURCE_KINDS`, `PERMISSION_AUDIENCES`, `PERMISSION_ACCESS_LEVELS`,
 * `REPAIR_OUTCOMES`, `RESOURCE_DRIFT_KINDS`) come from the modules that define them rather
 * than through the provisioning barrel: `z.enum` reads them while this module loads, and
 * route tests mock the barrel down to the functions they exercise.
 */
import { z } from '@hono/zod-openapi';
import type { ButtonListener } from '../../features/provisioning/buttonListeners';
import type { JourneyEntity } from '../../features/provisioning/data/journeysSchema';
import { REPAIR_OUTCOMES, type RepairedResource } from '../../features/provisioning/logic/applyDriftRepair';
import { DECLARED_ROLE_PREFIX } from '../../features/provisioning/logic/declaredRoleReference';
import type {
    JourneyMergePlan,
    KeyCollision,
    MovingResource,
    SharedTicketType,
} from '../../features/provisioning/logic/journeyMergePlan';
import {
    MESSAGE_BUTTON_EMOJI_NAME_MAX_LENGTH,
    MESSAGE_BUTTON_STYLES,
    MESSAGE_MAX_BUTTONS,
    type MessageButton,
    type MessageButtonEmoji,
} from '../../features/provisioning/logic/messageButtons';
import {
    describeMessageResourceProblem,
    messageResourceProblems,
} from '../../features/provisioning/logic/messageResourceProblems';
import {
    PERMISSION_ACCESS_LEVELS,
    PERMISSION_AUDIENCES,
    type PermissionIntent,
} from '../../features/provisioning/logic/permissionIntent';
import {
    DISCORD_RESOURCE_KINDS,
    RESOURCE_KINDS,
    type ResourceDeclaration,
} from '../../features/provisioning/logic/resourceDeclaration';
import { RESOURCE_DRIFT_KINDS } from '../../features/provisioning/logic/resourceDrift';
import { normaliseResourceName } from '../../features/provisioning/logic/resourceName';
import { ticketTypeDefinitionProblem } from '../../features/tickets/logic/setTicketTypes';
import { uploadSizesFor } from '../../features-system/guild-uploads/logic/readMessageUploads';
import { DISCORD_BUTTON_LABEL_MAX_LENGTH } from '../../shared/discordButtons';
import { messageUploadProblems } from '../../shared/discordMessage';
import { RESOURCE_KEY_MAX_LENGTH, RESOURCE_KEY_PATTERN } from '../../shared/resourceKey';
import { DiscordMessageSchema } from './messageBody';
import { TicketTypeSettingsSchema } from './ticketBody';
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

/*
 * How much one journey may declare. Far above anything authored — a journey is a handful
 * of channels and roles — so they only ever stop a request nobody built by hand. Every
 * resource is a Discord call at install, and every permission row an overwrite on it.
 */

/** The most resources one journey may declare. */
export const JOURNEY_MAX_RESOURCES = 100;

/** The most permission rows one resource may carry. */
export const JOURNEY_MAX_PERMISSIONS_PER_RESOURCE = 20;

/** The most roles one permission row may name. */
export const JOURNEY_MAX_ROLES_PER_PERMISSION = 50;

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
    .max(RESOURCE_KEY_MAX_LENGTH, `Resource keys cap at ${RESOURCE_KEY_MAX_LENGTH} characters.`)
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

/**
 * What kind of thing a declared resource is: a category, channel or role in the guild, a
 * ticket type in the guild's ticket settings, or a message the bot posts in one of the
 * journey's text channels.
 */
const ResourceKindSchema = z.enum(RESOURCE_KINDS).openapi('ResourceKind');

/**
 * The kinds of resource that are objects in the guild's cache — categories, channels and
 * roles, each with a snowflake, each adoptable. A `ticketType` is a row in the ticket
 * settings named by its key, and a `message` is posted by install inside a declared text
 * channel: neither has channel permissions or anything to adopt by id.
 *
 * No route sends it on its own; it is registered as a component (`openApiDocument.ts`) so
 * the browser branches on the server's own list before reaching for the channel or role
 * directory, rather than on a copy of it.
 */
export const DiscordResourceKindSchema = z.enum(DISCORD_RESOURCE_KINDS).openapi('DiscordResourceKind', {
    description:
        'The resource kinds that are objects in the Discord guild, each with a snowflake. A `ticketType` ' +
        'is not one: it lives in the ticket settings, named by its key. Nor is a `message`: install posts ' +
        'it in a declared text channel, and it is never adopted.',
});

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
        roleIds: z
            .array(PermissionRoleIdSchema)
            .max(JOURNEY_MAX_ROLES_PER_PERMISSION, `A permission names at most ${JOURNEY_MAX_ROLES_PER_PERMISSION} roles.`)
            .readonly()
            .optional(),
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

/** How a message's button looks: the four styles that answer a press. */
const MessageButtonStyleSchema = z.enum(MESSAGE_BUTTON_STYLES).openapi('MessageButtonStyle');

/**
 * The emoji on a message's button: Discord's partial emoji, `{ name }` for a standard one and
 * `{ id, name, animated }` for one of the server's own.
 *
 * One object for both, so `name` here can only be what both share. The rules keyed on whether
 * an `id` is present — a standard emoji's name is one emoji, a server emoji's name is
 * Discord's `[A-Za-z0-9_]{2,32}`, and only a server emoji is animated — span its fields, and
 * `messageResourceRefusal` asks them. Whether the id is one of this server's is install's
 * question, not the save's: an emoji can be deleted after it is picked.
 */
const MessageButtonEmojiSchema = z
    .object({
        name: z
            .string()
            .min(1, 'An emoji needs a name.')
            .max(MESSAGE_BUTTON_EMOJI_NAME_MAX_LENGTH, `Emoji names stop at ${MESSAGE_BUTTON_EMOJI_NAME_MAX_LENGTH} characters.`),
        id: z.string().regex(/^\d{17,20}$/, "A server emoji's id is 17 to 20 digits.").optional(),
        animated: z.boolean().optional(),
    })
    .openapi('MessageButtonEmoji', {
        description:
            "The emoji beside a button's label: `{ name }` with the glyph for a standard emoji, or " +
            "`{ id, name, animated }` for one of the server's own. A server emoji gone from the server " +
            'when the message is posted is left off the button.',
    });

/**
 * One button under a message resource.
 *
 * The key follows the resource key rule, for the same reason: it travels in the button's
 * custom_id (`mbtn:<key>`), which Discord caps at 100 characters. That keys are unique within
 * their message spans the list, so the spec cannot carry it; `messageResourceRefusal` asks.
 * So does the rule that a button has a label or an emoji, at least one.
 */
const MessageButtonSchema = z
    .object({
        key: z
            .string()
            .min(1, 'Give the button a key.')
            .max(RESOURCE_KEY_MAX_LENGTH, `Button keys cap at ${RESOURCE_KEY_MAX_LENGTH} characters.`)
            .regex(
                new RegExp(`^${RESOURCE_KEY_PATTERN}$`),
                'Button keys use lowercase letters, numbers and single hyphens (for example `let-me-in`).'
            ),
        label: z
            .string()
            .min(1, "A button's label can't be blank — write one, or leave it off and let the emoji talk.")
            .max(
                DISCORD_BUTTON_LABEL_MAX_LENGTH,
                `Button labels stop at ${DISCORD_BUTTON_LABEL_MAX_LENGTH} characters — Discord's rule, not ours.`
            )
            .optional(),
        style: MessageButtonStyleSchema,
        emoji: MessageButtonEmojiSchema.optional(),
    })
    .openapi('MessageButton', {
        description:
            'A button under a message resource. `key` is its identity within the message — what a press is ' +
            'routed by — so relabelling it changes nothing that listens to it. It has a `label`, an `emoji`, ' +
            'or both.',
    });

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
 *
 * A ticket type's label is trimmed instead, as the ticket feature trims it on create, so the
 * declaration, the binding's name and the type itself say the same thing — not run through
 * `normaliseResourceName`, which the panel runs as the operator types. A message's name is
 * trimmed the same way: Discord never sees it, only the dashboard and its refusals do.
 */
export const ResourceDeclarationSchema = z
    .object({
        key: resourceKeySchema,
        kind: ResourceKindSchema,
        /** For a `ticketType`, the type's label. */
        defaultName: z.string().min(1, 'Give the resource a name.').max(100, 'Resource names cap at 100 characters.'),
        parentKey: resourceKeySchema.optional(),
        permissions: z
            .array(PermissionIntentSchema)
            .max(
                JOURNEY_MAX_PERMISSIONS_PER_RESOURCE,
                `A resource has at most ${JOURNEY_MAX_PERMISSIONS_PER_RESOURCE} permission rows.`
            )
            .readonly()
            .optional(),
        description: z.string().max(500, 'Descriptions cap at 500 characters.').optional(),
        /** Set when the operator picked something that already exists instead of declaring a new one. */
        adoptDiscordId: discordIdSchema.optional(),
        /**
         * A ticket type's settings: what install creates the type with when the server has
         * none of this key (an existing type is used as it is). Which kinds may carry it is
         * `validateJourneyDeclaration`'s call; the rules that span the label or need the
         * renderer are {@link ticketTypeDeclarationRefusal}'s.
         */
        ticketType: TicketTypeSettingsSchema.optional(),
        /**
         * What a `message` resource posts. Its shape travels in the spec; the rules spanning
         * parts, the picture forms, the no-tokens rule and its uploads are the handler's
         * ({@link messageResourceRefusal}, {@link messageUploadsRefusal}). Which kinds may
         * carry it is `validateJourneyDeclaration`'s call.
         */
        message: DiscordMessageSchema.optional(),
        /** The buttons under a `message` resource, in order. */
        buttons: z
            .array(MessageButtonSchema)
            .max(MESSAGE_MAX_BUTTONS, `A message holds ${MESSAGE_MAX_BUTTONS} buttons, tops — five rows of five.`)
            .readonly()
            .optional(),
    })
    .transform((resource) => ({
        ...resource,
        defaultName:
            resource.kind === 'ticketType' || resource.kind === 'message'
                ? resource.defaultName.trim()
                : normaliseResourceName(resource.kind, resource.defaultName),
    }))
    .openapi('ResourceDeclaration', {
        description:
            'A resource a journey needs, named by a key stable across servers. `defaultName` is ' +
            'stored as Discord will hold it: a text channel lowercased, whitespace hyphenated; for a ' +
            '`ticketType` it is the type\'s label, and for a `message` the name the dashboard shows it ' +
            'by, both trimmed. `adoptDiscordId` adopts something that already exists instead of creating ' +
            'it. `ticketType` holds a ticket type\'s settings, and only a `ticketType` resource carries it. ' +
            '`message` and `buttons` hold what a `message` resource posts, and only a `message` carries ' +
            'them; its `parentKey` names the text channel it is posted in.',
    });

const ResourceDeclarationsSchema = z.array(ResourceDeclarationSchema).readonly();

/**
 * What a flow declares, as both its resource routes answer: the read and the save. `updatedAt`
 * is its journey's version — the one a save sends back as `baseUpdatedAt` — and `null` while
 * the flow is on no journey, so the first save, which creates one, knowingly sends none.
 */
export const FlowResourcesSchema = z.object({
    resources: ResourceDeclarationsSchema,
    updatedAt: z.union([z.string(), z.null()]),
});

/**
 * The version a resource save was edited from: the journey's `updatedAt` as the browser last
 * read it — off `GET /journeys/{journeyKey}`, `GET /flows/{flowId}/resources`, or the answer to
 * its own last save. Both resource PUTs replace the whole list, so one carrying a list read
 * before somebody else's save would delete what that save added; the version is how they tell.
 */
const resourcesBaseSchema = z.iso.datetime();

/**
 * The 409 of a resource save whose `baseUpdatedAt` is not the journey's version any more —
 * or that sent none, to a journey that exists. Nothing was written.
 */
export const STALE_RESOURCES_MESSAGE =
    'Somebody else got their hands on these resources since you loaded them, so saving would ' +
    'trample their changes. Reload the page, then make yours again.';

/**
 * The 409 of a grouping whose merge found the destination's resources moved on between the
 * route reading them and writing the merged list — a tab's save landing mid-drag. Nothing was
 * merged, and the flow was not moved.
 */
export const GROUP_CHANGED_MESSAGE = 'This group changed while you were dragging — try again.';

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

/**
 * Why a list of declarations is refused for a declared ticket type the ticket feature would
 * not create, or `undefined` when every one passes.
 *
 * The ticket feature's own rules (`ticketTypeDefinitionProblem`) — the label's 45-character
 * cap, the template's tokens, its rendered length — so a journey cannot store a type that
 * install's create would then refuse. Its key is the resource key, already a subset of what
 * a type key allows; its label is the resource's name, trimmed.
 *
 * Asked where {@link rolesWithoutIdsRefusal} is, for the same reason: the label cap spans
 * two fields (`kind` and `defaultName`) and the rendered length needs the renderer, so
 * neither can travel in the spec, and the request-rule emit would refuse it as a
 * `.superRefine()`. The template's tokens do travel, through `TicketTypeSettings`, so the
 * schema refuses those first with the same sentence. The browser warns about the rest with
 * its `invalidTicketType` chip.
 */
export function ticketTypeDeclarationRefusal(resources: readonly ResourceDeclaration[]): string | undefined {
    for (const resource of resources) {
        if (resource.kind !== 'ticketType' || !resource.ticketType) continue;

        const problem = ticketTypeDefinitionProblem({
            type: resource.key,
            label: resource.defaultName.trim(),
            ...resource.ticketType,
        });
        if (problem) return problem;
    }
    return undefined;
}

/**
 * Why a list of declarations is refused for a message resource that could not be posted as
 * it stands, or `undefined` when every one could. Names the first problem by the message's
 * name and part: `"Rules panel" embed 2 footer: …`.
 *
 * Provisioning's rules (`messageResourceProblems`): the message parses as a Post Embed
 * node's does, holds no `{{tokens}}` anywhere, and gives each button its own key. Asked
 * here rather than as a refinement for the reason the others are: each spans parts or needs
 * more than the spec can say, so the browser could not be given it.
 */
export function messageResourceRefusal(resources: readonly ResourceDeclaration[]): string | undefined {
    for (const resource of resources) {
        if (resource.kind !== 'message') continue;

        const [problem] = messageResourceProblems(resource);
        if (problem) return describeMessageResourceProblem(resource.defaultName, problem);
    }
    return undefined;
}

/**
 * What the routes that take resources refuse a valid-shaped list for, beyond the schema:
 * {@link rolesWithoutIdsRefusal}, then {@link ticketTypeDeclarationRefusal}, then
 * {@link messageResourceRefusal}. One call, so the three routes cannot ask a different set.
 * The uploads, which need the database, are {@link messageUploadsRefusal}'s, asked after it.
 */
export function declarationsRefusal(resources: readonly ResourceDeclaration[]): string | undefined {
    return rolesWithoutIdsRefusal(resources) ?? ticketTypeDeclarationRefusal(resources) ?? messageResourceRefusal(resources);
}

/**
 * Why a list of declarations is refused for a message resource's uploaded pictures, or
 * `undefined` when every one can go: each upload a message shows is this server's, and each
 * message stays within Discord's file count and bytes (`messageUploadProblems`, the rules a
 * Post Embed node is saved and run under). Named like {@link messageResourceRefusal}.
 *
 * Async because it reads the sizes this server holds: one query for every message in the
 * list, **for this guild only**, so an upload id copied from another server's journey is not
 * in it — and none at all when no message shows an upload. Sizes only, never the pictures.
 *
 * Awaited by the three routes straight after {@link declarationsRefusal}, before any write:
 * SQLite has one connection, so this must never run inside a transaction.
 */
export async function messageUploadsRefusal(
    guildId: string,
    resources: readonly ResourceDeclaration[]
): Promise<string | undefined> {
    const messages = resources.filter((resource) => resource.kind === 'message' && resource.message);
    const sizes = await uploadSizesFor(
        guildId,
        messages.flatMap((resource) => (resource.message ? [resource.message] : []))
    );

    for (const resource of messages) {
        const [problem] = messageUploadProblems(resource.message, sizes);
        if (problem) return describeMessageResourceProblem(resource.defaultName, problem);
    }
    return undefined;
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

/**
 * A journey's declarations, as every route that writes them takes them: one list, capped.
 * Each resource is a channel, role, category or ticket type an install makes one Discord
 * call for, so the cap bounds what one request can ask the bot to do.
 */
const journeyResourcesSchema = z
    .array(ResourceDeclarationSchema)
    .max(JOURNEY_MAX_RESOURCES, `A journey declares at most ${JOURNEY_MAX_RESOURCES} resources.`);

const journeyDescriptionSchema = z.string().max(500, 'Descriptions cap at 500 characters.');

/** The body of `POST /journeys`. */
export const JourneyCreateSchema = z
    .object({
        journeyKey: resourceKeySchema,
        name: journeyNameSchema,
        description: journeyDescriptionSchema.optional(),
        resources: journeyResourcesSchema,
    })
    .openapi('JourneyCreate');

/** The body of `PUT /journeys/{journeyKey}`: send only what changed. The key is identity and never changes. */
export const JourneyUpdateSchema = z
    .object({
        name: journeyNameSchema.optional(),
        description: journeyDescriptionSchema.nullable().optional(),
        resources: journeyResourcesSchema.optional(),
        baseUpdatedAt: resourcesBaseSchema.optional(),
    })
    .openapi('JourneyUpdate', {
        description:
            'A partial update: send only what changed. `description: null` clears it. `resources` ' +
            'replaces the whole list, and must come with `baseUpdatedAt`, the journey\'s `updatedAt` ' +
            'the list was edited from; a rename alone needs none.',
    });

/** The body of `PUT /flows/{flowId}/resources`: the whole list, an empty one removing the flow's journey. */
export const FlowResourcesSaveSchema = z
    .object({
        resources: journeyResourcesSchema,
        baseUpdatedAt: resourcesBaseSchema.optional(),
    })
    .openapi('FlowResourcesSave', {
        description:
            '`baseUpdatedAt` is the `updatedAt` the list was edited from, as the resource read or the ' +
            'last save answered it. Required once the flow is on a journey; left out by the first ' +
            'save, which creates one.',
    });

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
 *
 * `linked` is whether a link row names it. A flow from before the link table is on the
 * journey keyed by its own id with no row, and its first resource save through the flow
 * writes one — so the builder saves through the flow until this is true, and through the
 * journey after.
 */
export const FlowAttachmentSchema = z
    .object({
        journeyKey: z.string(),
        name: z.string(),
        resourceCount: z.number(),
        sharedWith: z.array(AttachedFlowSchema),
        linked: z.boolean(),
    })
    .openapi('FlowAttachment', {
        description:
            'The journey a flow installs. `sharedWith` is every other flow on it. `linked` is false for a flow from before the link table, on the journey keyed by its own id with no link row yet; its next resource save through the flow writes one.',
    });

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

/**
 * A ticket type both journeys declare under one key. Not a collision — the key is the type,
 * so the two are one type; merging keeps the destination's declaration and drops the moving
 * one's label.
 */
const SharedTicketTypeSchema = z
    .object({
        key: z.string(),
        /** The moving journey's label for it, which is dropped. */
        movingName: z.string(),
        /** The destination's label, which is kept. */
        destinationName: z.string(),
    })
    .openapi('SharedTicketType');

/** `planJourneyMerge`'s answer, which the preview sends as it is. Not a component of its own. */
const journeyMergePlanSchema = z.object({
    moving: z.array(MovingResourceSchema).readonly(),
    canMerge: z.boolean(),
    collisions: z.array(KeyCollisionSchema).readonly(),
    sharedTicketTypes: z.array(SharedTicketTypeSchema).readonly(),
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
        /** The group route's refusal, said first: a button both flows would listen to live. */
        buttonConflict: z.union([z.string(), z.null()]),
    })
    .openapi('GroupPreview', {
        description:
            'What grouping would do. `destination` is null when the target flow is on no journey ' +
            'yet, so one would be created. `orphaned` are the live resources "leave" would strand. ' +
            '`sharedTicketTypes` are ticket types both sides declare, which a merge folds into the ' +
            "destination's. `buttonConflict`, when set, is why the grouping would be refused: the " +
            'moving flow is live on a button a live flow of the destination already listens to.',
    });

/** One trigger listening to one of a journey's message buttons. */
const ButtonListenerSchema = z
    .object({
        messageKey: z.string(),
        buttonKey: z.string(),
        flowId: z.string(),
        flowName: z.string(),
        nodeId: z.string(),
        enabled: z.boolean(),
    })
    .openapi('ButtonListener', {
        description:
            'A Button Click trigger naming one of the journey\'s message buttons by its keys. ' +
            '`enabled` says whether its flow is switched on; an off flow is listed too.',
    });

/** Every trigger listening to the journey's message buttons, live and off. */
export const JourneyButtonListenersSchema = z
    .object({
        listeners: z.array(ButtonListenerSchema).readonly(),
    })
    .openapi('JourneyButtonListeners');

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
    MessageButton: SchemaMatches<typeof MessageButtonSchema, MessageButton>;
    MessageButtonEmoji: SchemaMatches<typeof MessageButtonEmojiSchema, MessageButtonEmoji>;
    ResourceDeclaration: SchemaMatches<typeof ResourceDeclarationSchema, ResourceDeclaration>;
    MovingResource: SchemaMatches<typeof MovingResourceSchema, MovingResource>;
    KeyCollision: SchemaMatches<typeof KeyCollisionSchema, KeyCollision>;
    SharedTicketType: SchemaMatches<typeof SharedTicketTypeSchema, SharedTicketType>;
    JourneyMergePlan: SchemaMatches<typeof journeyMergePlanSchema, JourneyMergePlan>;
    RepairedResource: SchemaMatches<typeof RepairedResourceSchema, RepairedResource>;
    ButtonListener: SchemaMatches<typeof ButtonListenerSchema, ButtonListener>;
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

/**
 * A journey's version as the API states it: its `updatedAt`, as an ISO string — what a
 * resource save sends back as `baseUpdatedAt`. Every write goes through `journeysRepo`, which
 * moves it forward, so it changes exactly when the journey does.
 */
export function journeyVersion(journey: Pick<JourneyEntity, 'updatedAt'>): string {
    return new Date(journey.updatedAt).toISOString();
}

/** A stored journey as the routes send it. */
export function journeyDetail(journey: JourneyEntity): z.infer<typeof JourneySchema> {
    return {
        journeyKey: journey.journeyKey,
        name: journey.name,
        description: journey.description,
        resources: journey.resources,
        createdAt: new Date(journey.createdAt).toISOString(),
        updatedAt: journeyVersion(journey),
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
