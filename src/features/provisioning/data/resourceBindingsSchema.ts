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
 * `(guildId, journeyKey, resourceKey) → discordId`, with provenance.
 *
 * Keyed by journey as well as guild because a resource key is only unique within its
 * journey; two journeys may each declare `welcome-channel` and mean different things.
 * (Sharing one channel *between* journeys was cut as a non-requirement on 2026-09-24:
 * two journeys needing one channel are one journey split by mistake.)
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
     * Explicitly *not* used for lookup — that was issue #22 in the ticket feature, where
     * a category was found by matching `channel.name` and a rename silently produced a
     * duplicate. Resolution here is always by `discordId`.
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
