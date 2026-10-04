import { z } from '@hono/zod-openapi';
import type { Guild } from 'discord.js';
import {
    isTicketingConfigConfigured,
    TICKET_CATEGORY_PROVENANCES,
    TICKET_CATEGORY_SLOTS,
    type TicketCategoryBinding,
    type TicketCategorySlot,
    type TicketingConfig,
    type TicketPermissionModel,
    type TicketRolePermissions,
} from '../../features/tickets/data/ticketingSchema';
import { TICKET_STATUSES, type TicketEntity } from '../../features/tickets/data/ticketsSchema';
import { getTicketTypeDefinition } from '../../features/tickets/logic/ticketTypes';
import type { SchemaMatches } from './openApi';

/**
 * The ticket shapes the browser receives.
 *
 * Each is a zod schema, and the schema **is** the contract: `ticketRoutes` declares it on
 * its routes, `router.openapi` type-checks every `c.json(...)` against it, and the OpenAPI
 * spec the dashboard SDK is generated from names it as a component. The `.openapi('Name')`
 * ids are the names the dashboard imports by, so renaming one renames a generated type.
 * They follow the browser's names (`TicketingConfigView`, `TicketTypeView`), as the flow
 * shapes do.
 *
 * The builders below are typed by `z.infer` of their schema, so a member the schema does
 * not describe is a compile error where the body is built. The two permission shapes are
 * domain types sent as they are, so they stay in `ticketingSchema.ts` and are held to
 * their schemas both ways by {@link SchemaMatches}.
 *
 * Every schema here is made with `@hono/zod-openapi`'s `z`; see `FlowGraphSchema` in
 * `flowBody.ts` for why a schema made in `src/features` cannot be named.
 */

/** The ticket lifecycle. A closed union: the row's category routing and its buttons switch on it. */
const TicketStatusSchema = z.enum(TICKET_STATUSES).openapi('TicketStatus');

/**
 * A person on a ticket, rendered from the row's own snapshot.
 *
 * Null names on a row written before the snapshot columns existed; the dashboard shows
 * the id then. Not backfilled, because backfilling means fetching every historical
 * member — the Discord call this shape exists to avoid.
 */
const TicketParticipantSchema = z
    .object({
        id: z.string(),
        username: z.string().nullable(),
        nickname: z.string().nullable(),
    })
    .openapi('TicketParticipant', {
        description:
            'A person on a ticket, as the row recorded them. Both names are null on a row written ' +
            'before names were recorded; show the id then.',
    });

type TicketParticipantBody = z.infer<typeof TicketParticipantSchema>;

/** A row in the tickets list. */
const TicketSummarySchema = z
    .object({
        id: z.number(),
        ticketNumber: z.number(),
        type: z.string(),
        typeLabel: z.string().nullable(),
        status: TicketStatusSchema,
        title: z.string(),
        subject: TicketParticipantSchema,
        // Unions rather than `.nullable()`: the generator copies a named schema's name onto
        // its nullable variant, so the component itself would become nullable.
        opener: z.union([TicketParticipantSchema, z.null()]),
        claimer: z.union([TicketParticipantSchema, z.null()]),
        channelId: z.string().nullable(),
        openedAt: z.string(),
        updatedAt: z.string(),
    })
    .openapi('TicketSummary', {
        description:
            'A row in the tickets list. `typeLabel` is null when the server no longer declares the ' +
            "ticket's type; show `type` then.",
    });

type TicketSummaryBody = z.infer<typeof TicketSummarySchema>;

/**
 * One ticket in full: the summary plus the reason and the rest of its timeline.
 *
 * There is no `messages` member and there will not be one. A ticket stores no
 * conversation — that lives in the Discord channel and is not in this database — so the
 * detail page links to the channel rather than pretending to have its history.
 */
export const TicketDetailSchema = TicketSummarySchema.extend({
    reason: z.string(),
    claimedAt: z.string().nullable(),
    closedAt: z.string().nullable(),
    deletedAt: z.string().nullable(),
}).openapi('TicketDetail', {
    description:
        'One ticket in full: the list row plus its reason and timeline. The conversation is not ' +
        'here; it lives in the Discord channel.',
});

type TicketDetailBody = z.infer<typeof TicketDetailSchema>;

/**
 * A lifecycle response: the updated ticket, plus whether Discord kept up.
 *
 * `syncWarning` is the highest-consequence string the feature sends: on a close it is the
 * sentence saying the subject may still be able to read the channel.
 */
export const TicketActionResultSchema = TicketDetailSchema.extend({
    syncWarning: z.string().nullable(),
}).openapi('TicketActionResult', {
    description:
        'The ticket after a lifecycle action. `syncWarning` is set when the ticket changed and its ' +
        'channel did not follow — on a close, that the subject may still be able to read it. Show it.',
});

/** The three numbers the list's counts strip shows, for the whole guild. */
const TicketCountsSchema = z
    .object({
        open: z.number(),
        unclaimed: z.number(),
        closed: z.number(),
    })
    .openapi('TicketCounts', {
        description: "The server's ticket totals, whatever the list is filtered to.",
    });

/** The body of `GET /tickets`. */
export const TicketListSchema = z
    .object({
        tickets: z.array(TicketSummarySchema),
        counts: TicketCountsSchema,
        truncated: z.boolean(),
    })
    .openapi('TicketList', {
        description:
            'The tickets matching the filter, newest first. `truncated` means the list was capped and ' +
            'more match; `counts` still reports the whole server.',
    });

const TicketRolePermissionsSchema = z
    .object({
        view: z.boolean(),
        send: z.boolean(),
        readHistory: z.boolean(),
        manageMessages: z.boolean(),
    })
    .openapi('TicketRolePermissions', {
        description: 'What one person on a ticket may do in its channel.',
    });

const ticketRolePermissionsSchemaMatches: SchemaMatches<typeof TicketRolePermissionsSchema, TicketRolePermissions> =
    true;
void ticketRolePermissionsSchemaMatches;

/** The permission model for one ticket type: the three people a ticket involves. Request and response both. */
export const TicketPermissionModelSchema = z
    .object({
        subject: TicketRolePermissionsSchema,
        opener: TicketRolePermissionsSchema,
        staff: TicketRolePermissionsSchema,
    })
    .openapi('TicketPermissionModel', {
        description:
            'Who may do what in a ticket channel: `subject` is who the ticket is about, `opener` whoever ' +
            'filed it, `staff` the moderation roles.',
    });

const ticketPermissionModelSchemaMatches: SchemaMatches<typeof TicketPermissionModelSchema, TicketPermissionModel> =
    true;
void ticketPermissionModelSchemaMatches;

/** One declared type, as the config editor reads it. */
const TicketTypeViewSchema = z
    .object({
        type: z.string(),
        label: z.string(),
        nameTemplate: z.string(),
        permissions: TicketPermissionModelSchema,
        autoClaimOnOpen: z.boolean(),
    })
    .openapi('TicketTypeView', {
        description: 'One declared ticket type. `type` is its key: identity, fixed once saved.',
    });

/**
 * One category slot, for the settings page.
 *
 * `name` is the expected name — what a deleted category is remade as. `liveName` is what
 * Discord calls the bound category now, or null when nothing is bound or the category is
 * gone; the two differ after a rename, which is harmless and worth showing. A slot with a
 * name and no `discordId` is the migration's "linked to nothing yet" state.
 */
const TicketCategoryViewSchema = z
    .object({
        name: z.string(),
        discordId: z.string().nullable(),
        provenance: z.enum(TICKET_CATEGORY_PROVENANCES).nullable(),
        liveName: z.string().nullable(),
    })
    .openapi('TicketCategoryView', {
        description:
            'One category slot. `name` is the expected name, `liveName` what Discord calls the bound ' +
            'category now (null when nothing is bound, or it is gone). A `name` with no `discordId` is ' +
            'linked to nothing yet, and tickets stop until it is.',
    });

type TicketCategoryViewBody = z.infer<typeof TicketCategoryViewSchema>;

/**
 * An object shape with one member per category slot, each held to `slot`, so a fourth
 * server-side slot is a fourth member in the spec rather than one the builders' cast lets
 * through undescribed.
 */
export function categorySlotsShape<Slot extends z.ZodType>(slot: Slot): Record<TicketCategorySlot, Slot> {
    return Object.fromEntries(TICKET_CATEGORY_SLOTS.map((name) => [name, slot])) as Record<TicketCategorySlot, Slot>;
}

/**
 * The ticket config for the config page.
 *
 * `deployed` rather than the three `modTicketsDeployed*` members: the page needs to know
 * whether there is a panel, not which message id it is. `moderationRoles` carries resolved
 * names beside the ids for the same reason `resolveGuildSettings` does — so a role renders
 * without a second round trip — and a role deleted since it was saved keeps its id and
 * loses its name rather than being quietly dropped from what was saved.
 */
export const TicketingConfigViewSchema = z
    .object({
        configured: z.boolean(),
        deployed: z.boolean(),
        categories: z.object(categorySlotsShape(z.union([TicketCategoryViewSchema, z.null()]))),
        moderationRoleIds: z.array(z.string()),
        moderationRoles: z.array(z.object({ id: z.string(), name: z.string() })),
        types: z.array(TicketTypeViewSchema),
    })
    .openapi('TicketingConfigView', {
        description:
            "The server's ticket settings and declared types. `categories` is null per slot when " +
            'nothing is chosen. A saved moderation role that no longer exists stays in ' +
            '`moderationRoleIds` and is missing from `moderationRoles`.',
    });

type TicketingConfigViewBody = z.infer<typeof TicketingConfigViewSchema>;

/* ---- Builders ---- */

/** An id paired with whatever names the row recorded for it. */
function participant(id: string, username: string | null, nickname: string | null): TicketParticipantBody {
    return { id, username, nickname };
}

/** A ticket row as {@link TicketSummarySchema}, its label resolved from the guild's config. */
export function ticketSummary(ticket: TicketEntity, config: TicketingConfig | null): TicketSummaryBody {
    return {
        id: ticket.id,
        ticketNumber: ticket.ticketNumber,
        type: ticket.type,
        typeLabel: config ? getTicketTypeDefinition(config, ticket.type)?.label ?? null : null,
        status: ticket.status,
        title: ticket.title,
        subject: participant(ticket.subjectId, ticket.subjectUsername, ticket.subjectNickname),
        opener: ticket.openerId ? participant(ticket.openerId, ticket.openerUsername, ticket.openerNickname) : null,
        claimer: ticket.claimerId
            ? participant(ticket.claimerId, ticket.claimerUsername, ticket.claimerNickname)
            : null,
        channelId: ticket.channelId,
        openedAt: new Date(ticket.openedAt).toISOString(),
        updatedAt: new Date(ticket.updatedAt).toISOString(),
    };
}

/** A ticket row as {@link TicketDetailSchema}. */
export function ticketDetail(ticket: TicketEntity, config: TicketingConfig | null): TicketDetailBody {
    return {
        ...ticketSummary(ticket, config),
        reason: ticket.reason,
        claimedAt: ticket.claimedAt ? new Date(ticket.claimedAt).toISOString() : null,
        closedAt: ticket.closedAt ? new Date(ticket.closedAt).toISOString() : null,
        deletedAt: ticket.deletedAt ? new Date(ticket.deletedAt).toISOString() : null,
    };
}

function categoryView(guild: Guild, binding: TicketCategoryBinding): TicketCategoryViewBody | null {
    if (!binding) return null;
    if (!binding.discordId) return { name: binding.name, discordId: null, provenance: null, liveName: null };
    return {
        name: binding.name,
        discordId: binding.discordId,
        provenance: binding.provenance,
        liveName: guild.channels.cache.get(binding.discordId)?.name ?? null,
    };
}

/** A guild's ticket config — or its absence — as {@link TicketingConfigViewSchema}. */
export function ticketingConfigView(guild: Guild, config: TicketingConfig | null): TicketingConfigViewBody {
    const moderationRoleIds = config?.moderationRoles ?? [];

    return {
        // A guild with no row is not configured and is not an error: it is a guild that
        // has not run `/deploy-ticket-system` yet, and the page says so rather than
        // 404ing at an operator who came to set it up.
        configured: isTicketingConfigConfigured(
            config ? { id: 0, guildId: guild.id, config, ticketNumberInc: 0, entityVersion: 1 } : null
        ),
        deployed: config?.modTicketsDeployed ?? false,
        categories: Object.fromEntries(
            TICKET_CATEGORY_SLOTS.map((slot) => [slot, categoryView(guild, config?.categories[slot] ?? null)])
        ) as Record<TicketCategorySlot, TicketCategoryViewBody | null>,
        moderationRoleIds: [...moderationRoleIds],
        moderationRoles: moderationRoleIds
            .map((roleId) => guild.roles.cache.get(roleId))
            .filter((role): role is NonNullable<typeof role> => !!role)
            .map((role) => ({ id: role.id, name: role.name })),
        // Sorted by label so the editor's row order does not depend on JSON key order,
        // which is insertion-ordered and would shuffle when a type is replaced.
        types: Object.values(config?.ticketTypes ?? {})
            .map((definition) => ({
                type: definition.type,
                label: definition.label,
                nameTemplate: definition.nameTemplate,
                permissions: definition.permissions,
                autoClaimOnOpen: definition.autoClaimOnOpen,
            }))
            .sort((left, right) => left.label.localeCompare(right.label)),
    };
}
