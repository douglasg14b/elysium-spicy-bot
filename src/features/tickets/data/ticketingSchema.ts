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
 * category — all three categories stay guild-wide
 * (`supportTicketCategoryName`, `claimedTicketCategoryName`,
 * `closedTicketCategoryName`) and `syncTicketChannelToState` keeps routing by
 * *status*, not by type. **Not** the opening content and **not** the available
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

export interface TicketingConfig {
    modTicketsDeployed: boolean;
    modTicketsDeployedChannelId: string | null;
    modTicketsDeployedMessageId: string | null;

    supportTicketCategoryName: string;
    claimedTicketCategoryName: string;
    closedTicketCategoryName: string;

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
 */
export function isTicketingConfigConfigured(
    entity: TicketingConfigEntity | null | undefined
): entity is NonNullable<ConfiguredTicketingConfigEntity> {
    if (!entity || !entity.config) {
        return false;
    }

    const {
        modTicketsDeployed,
        supportTicketCategoryName,
        closedTicketCategoryName,
        claimedTicketCategoryName,
        moderationRoles,
        modTicketsDeployedChannelId,
        modTicketsDeployedMessageId,
    } = entity.config;

    return (
        modTicketsDeployed &&
        !!claimedTicketCategoryName &&
        !!supportTicketCategoryName &&
        !!closedTicketCategoryName &&
        !!modTicketsDeployedChannelId &&
        !!modTicketsDeployedMessageId &&
        moderationRoles.length > 0
    );
}
