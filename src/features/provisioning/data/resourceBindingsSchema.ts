import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';
import type { ResourceKind } from '../logic/resourceDeclaration';

/**
 * How a binding came to exist, and how far it got.
 *
 * `intended` is the crash-safety state and the reason this column is not a boolean.
 * A row is written as `intended` *before* the guild is mutated, so a crash between
 * creating a channel and recording its id leaves evidence rather than an orphan. On
 * the next install, `buildInstallPlan` looks for the object an `intended` row was
 * about to create — its kind and name, created after the row was written, bound by
 * nothing else — and plans a `recover` that settles it as `created`. Several such
 * objects block and ask; none means the create never landed (PRD §5.7).
 *
 * `created` and `adopted` are both live states; they differ only in provenance, which
 * matters for teardown — 5B may delete what it created and must never delete what it
 * adopted.
 */
export const RESOURCE_BINDING_STATES = ['intended', 'created', 'adopted'] as const;
export type ResourceBindingState = (typeof RESOURCE_BINDING_STATES)[number];

/**
 * Who a binding belongs to: a journey, or the ticket feature.
 *
 * A literal union rather than a registry of owners, because these two are all there is.
 * PRD §5.7 (a subsystem's configuration as a declarable resource) is where it may widen.
 *
 * A separate column rather than a reserved `owner_key`, because a journey's key is chosen
 * by the operator: a journey called `tickets` is legal, and must never be read as the
 * ticket feature or take its rows.
 */
export const BINDING_OWNER_KINDS = ['journey', 'tickets'] as const;
export type BindingOwnerKind = (typeof BINDING_OWNER_KINDS)[number];

/** One owner of bindings: its kind, and its key within that kind. */
export interface BindingOwner {
    readonly kind: BindingOwnerKind;
    readonly key: string;
}

/**
 * The ticket feature, as an owner. It owns one set of rows per guild, so its key is fixed;
 * each row's `resourceKey` is a server-wide category slot (`open`, `claimed`, `closed`) or
 * a ticket type's own category in a slot (`typeCategoryKey` in `ticketingSchema.ts`).
 */
export const TICKETS_OWNER: BindingOwner = { kind: 'tickets', key: 'tickets' };

/** A journey, as an owner. */
export function journeyOwner(journeyKey: string): BindingOwner {
    return { kind: 'journey', key: journeyKey };
}

/**
 * `(guildId, ownerKind, ownerKey, resourceKey) → discordId`, with provenance.
 *
 * The one record of the Discord objects the bot owns, for journeys and for the ticket
 * feature alike. Until 2026-10-10 tickets kept their three categories inside the
 * `ticketing_config` blob, where no fence here could see them — so a journey's crash
 * recovery could take a ticket category, and either side could adopt the other's.
 *
 * Keyed by owner as well as guild because a resource key is only unique within its
 * owner; two journeys may each declare `welcome-channel` and mean different things.
 *
 * **One owner per object** is enforced when an object is claimed (`ownerOf`, and the
 * conditional adopted `settle`/`rebind`), not by an index: one owner's two ticket slots
 * may legitimately share a category, so `discord_id` cannot be unique. (Sharing one
 * channel *between* journeys was cut as a non-requirement on 2026-09-24: two journeys
 * needing one channel are one journey split by mistake.)
 *
 * `discordId` is nullable because a row exists before the resource does. That is the
 * entire point of writing it first, and it is why the unique index below covers the
 * owner and resource key rather than the id.
 */
export interface ResourceBindingTable {
    id: Generated<number>;

    guildId: string;
    ownerKind: BindingOwnerKind;
    /** A journey's key, or `'tickets'` for the ticket feature. Read together with `ownerKind`. */
    ownerKey: string;
    resourceKey: string;

    kind: ResourceKind;
    state: ResourceBindingState;

    /**
     * A snowflake, or a ticket type's key for `ticketType`. Null while `state` is
     * `intended`; set once the guild object exists.
     *
     * The column keeps its name for the second meaning rather than gaining a twin, so
     * **every reader branches on `kind` first**: a type key can be all digits, and read as
     * a snowflake it would fence, resolve or delete the wrong thing. The Discord-only
     * helpers take a `DiscordResourceKind`, and `loadGuildOwnership` and `ownerOf` leave
     * type rows out of every "who holds this object?" question.
     */
    discordId: string | null;

    /**
     * The **expected** name: what the object is meant to be called.
     *
     * Read by drift, which measures an adopted object against it, by the ticket feature,
     * which recreates a deleted category under it, and by every report that describes a
     * resource to an operator. For an `intended` row it is the name a create is about to
     * use, which is what crash recovery searches for.
     *
     * Explicitly *not* used to find an object — that was issue #22 in the ticket feature,
     * where a category was found by matching `channel.name` and a rename silently produced
     * a duplicate. Resolution is always by `discordId`.
     */
    name: string;

    /**
     * For a `message`: the channel it was posted in. Null on every other kind.
     *
     * The binding carries it because uninstall and the orphan list work from binding rows
     * alone (`buildUnpublishPlan`), with no declaration to find the parent channel through
     * — and a message cannot be found, or deleted, without its channel. Discord cannot move
     * a message, so this never changes while the row names the same message.
     */
    messageChannelId: ColumnType<string | null, string | null | undefined, string | null>;

    /**
     * For a `message`: the fingerprint of the declaration it was posted, or last repaired,
     * from (`messageDigest`). Null on every other kind. Drift reads it: nobody but the bot
     * can edit what the bot posted, so a stale fingerprint is the only way a message drifts.
     */
    messageDigest: ColumnType<string | null, string | null | undefined, string | null>;

    createdAt: ColumnType<Date, string, string>;
    updatedAt: ColumnType<Date, string, string>;
}

export type ResourceBindingEntity = Selectable<ResourceBindingTable>;
export type NewResourceBindingEntity = Insertable<ResourceBindingTable>;
export type ResourceBindingUpdateEntity = Updateable<ResourceBindingTable>;

export function isResourceBindingState(value: string): value is ResourceBindingState {
    return (RESOURCE_BINDING_STATES as readonly string[]).includes(value);
}
