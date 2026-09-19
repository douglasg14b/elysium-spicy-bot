import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';
import type { ResourceKind } from '../logic/resourceDeclaration';

/**
 * How a binding came to exist, and how far it got.
 *
 * `intended` is the crash-safety state and the reason this column is not a boolean.
 * A row is written as `intended` *before* the guild is mutated, so a crash between
 * creating a channel and recording its id leaves evidence rather than an orphan. On
 * the next install the reconciler sees an `intended` row with no `discordId`, looks
 * for what it was about to create, and adopts or reports it instead of blindly
 * creating a duplicate (PRD §5.7).
 *
 * `created` and `adopted` are both live states; they differ only in provenance, which
 * matters for teardown — 5B may delete what it created and must never delete what it
 * adopted.
 */
export const RESOURCE_BINDING_STATES = ['intended', 'created', 'adopted'] as const;
export type ResourceBindingState = (typeof RESOURCE_BINDING_STATES)[number];

/**
 * `(guildId, journeyKey, resourceKey) → discordId`, with provenance.
 *
 * Keyed by journey as well as guild because a resource key is only unique within its
 * journey; two journeys may each declare `welcome-channel` and mean different things.
 * (Sharing one channel *between* journeys is a 5B requirement — it needs unmanaging
 * under one journey to leave the other intact, which this shape allows but 5A does
 * not implement.)
 *
 * `discordId` is nullable because a row exists before the resource does. That is the
 * entire point of writing it first, and it is why the unique index below covers the
 * key triple rather than the id.
 */
export interface ResourceBindingTable {
    id: Generated<number>;

    guildId: string;
    journeyKey: string;
    resourceKey: string;

    kind: ResourceKind;
    state: ResourceBindingState;

    /** Null while `state` is `intended`; set once the guild object exists. */
    discordId: string | null;

    /**
     * The name at bind time, kept for diagnostics only.
     *
     * Explicitly *not* used for lookup — that is the defect issue #22 records in the
     * ticket feature, where a category is found by matching `channel.name` and a
     * rename silently produces a duplicate. Resolution here is always by `discordId`.
     */
    name: string;

    createdAt: ColumnType<Date, string, string>;
    updatedAt: ColumnType<Date, string, string>;
}

export type ResourceBindingEntity = Selectable<ResourceBindingTable>;
export type NewResourceBindingEntity = Insertable<ResourceBindingTable>;
export type ResourceBindingUpdateEntity = Updateable<ResourceBindingTable>;

export function isResourceBindingState(value: string): value is ResourceBindingState {
    return (RESOURCE_BINDING_STATES as readonly string[]).includes(value);
}
