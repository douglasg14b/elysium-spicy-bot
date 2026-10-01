import type { Generated, Insertable, JSONColumnType, Selectable, Updateable } from 'kysely';

export interface TicketingConfigTable {
    id: Generated<number>;

    // Index
    guildId: string;
    config: JSONColumnType<TicketingConfig>;

    /** The current ticket number increment */
    ticketNumberInc: number;

    entityVersion: number; // For schema migrations
}

export type TicketingConfigEntity = Selectable<TicketingConfigTable>;
export type NewTicketingConfigEntity = Insertable<TicketingConfigTable>;
export type TicketingConfigUpdateEntity = Updateable<TicketingConfigTable>;

/**
 * Who gets what on a ticket channel, declared once per role a person can play.
 *
 * Lifted to data rather than written inline at each site because the old code
 * expressed its permission intent three times — at creation, at close, at reopen
 * — and the three had already drifted: `createTicketChannel` denied `@everyone`
 * explicitly while `reopenTicketChannel` reset it to inherit, so a reopened
 * ticket was *more* permissive than the same ticket when new, and whether that
 * mattered depended on which category it landed in.
 *
 * Lives here rather than in `logic/ticketTypes.ts` because it is now part of the
 * persisted `config` JSON shape, and `logic/` must not own a column's type.
 */
export interface TicketRolePermissions {
    readonly view: boolean;
    readonly send: boolean;
    readonly readHistory: boolean;
    readonly manageMessages: boolean;
}

/**
 * The permission model for one ticket type.
 *
 * `subject` is who the ticket is about, `opener` whoever filed it (absent when a
 * flow did), `staff` the configured moderation roles. `everyone` is always a
 * denial; it is named rather than assumed so the drift above stays impossible to
 * reintroduce.
 */
export interface TicketPermissionModel {
    readonly subject: TicketRolePermissions;
    readonly opener: TicketRolePermissions;
    readonly staff: TicketRolePermissions;
}

/**
 * One ticket type, as an operator declares it.
 *
 * Four members beyond the key, and the boundary is deliberate. **Not** the
 * category — all three categories stay guild-wide (`TicketingConfig.categories`)
 * and `syncTicketChannelToState` keeps routing by *status*, not by type.
 * **Not** the opening content and **not** the available
 * controls: both are carried-forward items and both would need a second editor
 * before they are worth having.
 *
 * `type` is the key and lives inside the record as well as being its map key,
 * because every consumer of a definition today reads `definition.type` — and a
 * shape where the two can disagree is a shape that will.
 */
export interface TicketTypeDefinition {
    readonly type: string;
    readonly label: string;
    /**
     * Channel name template. `{{####}}` is the zero-padded ticket number,
     * `{{subject}}` and `{{opener}}` the sanitized usernames.
     *
     * These are the only three tokens `buildTicketChannelName` implements, and
     * that is now checked at save time rather than silently ignored — which is
     * what the old `SUPPORT_TICKET_NAME_TEMPLATE`'s `{{user}}`/`{{creator}}` did
     * for a year.
     */
    readonly nameTemplate: string;
    readonly permissions: TicketPermissionModel;
    /**
     * Whether opening auto-claims to the opener.
     *
     * True for support, because a moderator filing a ticket about someone is
     * already handling it. False for verification: a flow opens it and no human
     * has picked it up yet.
     */
    readonly autoClaimOnOpen: boolean;
}

/**
 * The three places a ticket channel can sit, by where the ticket is in its life.
 *
 * `open` is unclaimed, `claimed` is open and owned, `closed` covers closed and deleted.
 * The order is the order the dashboard lists them in.
 */
export const TICKET_CATEGORY_SLOTS = ['open', 'claimed', 'closed'] as const;
export type TicketCategorySlot = (typeof TICKET_CATEGORY_SLOTS)[number];

/** How each slot is named to an operator, in every message that names one. */
export const TICKET_CATEGORY_LABELS: Readonly<Record<TicketCategorySlot, string>> = {
    open: 'open tickets',
    claimed: 'claimed tickets',
    closed: 'closed tickets',
};

/** Whether the bot made a bound category or was handed one that already existed. */
export type TicketCategoryProvenance = 'created' | 'adopted';

/**
 * A slot with an expected name and no category behind it.
 *
 * What the 2026-10-01 migration leaves for every guild that had a name configured, and
 * what a crash between creating a category and recording it leaves. **Never resolved by
 * name at runtime** — finding a category by `channel.name` is issue #22 — so a slot in
 * this state stops tickets until the operator links it on the dashboard.
 */
export interface UnboundTicketCategory {
    readonly name: string;
    readonly discordId: null;
}

/**
 * A slot tied to a real category.
 *
 * `discordId` is what every lookup uses. `name` is the **expected** name: the one a
 * deleted category is recreated under, and nothing else — a rename in Discord changes
 * nothing here and breaks nothing. The same shape as a `resource_bindings` row (expected
 * name, id, provenance), kept in this blob until one owner-keyed table holds both.
 */
export interface BoundTicketCategory {
    readonly name: string;
    readonly discordId: string;
    readonly provenance: TicketCategoryProvenance;
}

/** One category slot. `null` is "nothing chosen yet". */
export type TicketCategoryBinding = UnboundTicketCategory | BoundTicketCategory | null;

export function isBoundTicketCategory(binding: TicketCategoryBinding): binding is BoundTicketCategory {
    return !!binding?.discordId;
}

export interface TicketingConfig {
    modTicketsDeployed: boolean;
    modTicketsDeployedChannelId: string | null;
    modTicketsDeployedMessageId: string | null;

    /**
     * Where ticket channels live, by id. Replaced three category *names* on
     * 2026-10-01 (issue #22); see `docs/plans/22-ticket-categories-bound-by-id.md`.
     *
     * **Required on read**, unlike `ticketTypes`: the 2026-10-01 migration gave every
     * existing row this member, and every writer that creates a row (deploy, the config
     * modal) seeds it. A row without it was written by hand, and reading it fails loudly.
     */
    categories: Record<TicketCategorySlot, TicketCategoryBinding>;

    moderationRoles: string[];

    /**
     * The guild's ticket types, keyed by `type`.
     *
     * A record rather than an array so a lookup is one index rather than a
     * `.find()` at seven call sites, and so duplicate keys are unrepresentable
     * rather than merely refused.
     *
     * **Optional on read, never on write.** A row written before the
     * `2026-09-23` migration cannot have it, and the seed backfills every row
     * *that exists* — but `config` is a JSON blob with no schema behind it, so a
     * row that arrives without it must degrade nameably rather than crash.
     * `getTicketTypeDefinition` returns `undefined`, and the two entry points
     * that open or act on a ticket refuse by name. Do **not** paper over an
     * absent definition with a default: a default here is exactly the silent
     * fallback the refusal exists to forbid.
     */
    ticketTypes?: Record<string, TicketTypeDefinition>;
}

export interface ConfiguredTicketingConfig extends TicketingConfig {
    modTicketsDeployed: true;
    modTicketsDeployedChannelId: string;
    modTicketsDeployedMessageId: string;
    /** Narrowed by the guard, so nothing downstream re-checks a slot it already proved. */
    categories: Record<TicketCategorySlot, BoundTicketCategory>;
}

export type ConfiguredTicketingConfigEntity = TicketingConfigEntity & {
    config: ConfiguredTicketingConfig;
};

/**
 * Whether the guild's ticket system is set up enough to act on.
 *
 * **Deliberately no `ticketTypes` requirement.** A guild with zero types
 * declared still has a working panel and working buttons on existing tickets;
 * requiring types to consider the system configured would brick the
 * `resolveTicketAction` gate for every guild between the migration and its first
 * config save. Stated here because it is the tempting wrong move.
 *
 * **Every category slot must be bound.** A slot holding only an expected name is not
 * enough, because the only way to act on one would be to find a category by name.
 */
export function isTicketingConfigConfigured(
    entity: TicketingConfigEntity | null | undefined
): entity is NonNullable<ConfiguredTicketingConfigEntity> {
    if (!entity || !entity.config) {
        return false;
    }

    const { modTicketsDeployed, categories, moderationRoles, modTicketsDeployedChannelId, modTicketsDeployedMessageId } =
        entity.config;

    return (
        modTicketsDeployed &&
        TICKET_CATEGORY_SLOTS.every((slot) => isBoundTicketCategory(categories[slot])) &&
        !!modTicketsDeployedChannelId &&
        !!modTicketsDeployedMessageId &&
        moderationRoles.length > 0
    );
}
