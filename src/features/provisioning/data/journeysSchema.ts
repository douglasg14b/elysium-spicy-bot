import type { ColumnType, Generated, Insertable, JSONColumnType, Selectable, Updateable } from 'kysely';
import type { ResourceDeclaration } from '../logic/resourceDeclaration';

/**
 * One row per journey; a guild has many.
 *
 * This table is what makes a journey an operator-authored *record* rather than a
 * TypeScript constant. 5A shipped with the noun existing only as a hardcoded
 * `JourneyDeclaration`, which meant the engine was neutral about journey content and
 * an operator still could not create one — the weak property, not the strong one.
 *
 * `resources` is a JSON column following the `flows.graph` and `ticketing_config.config`
 * precedent. The whole declaration is always read together — a plan needs every
 * resource to order parents before children, and pickers need the full key set — so a
 * child table would buy per-resource queries nobody makes, at the cost of a join and a
 * second write path on every save.
 */
export interface JourneyTable {
    id: Generated<number>;

    /**
     * Stable per guild, referenced by `resource_bindings.journey_key` and by node
     * configs. Not a UUID: it is the operator-visible scope name, and it appears in
     * the binding table's unique index, so it must read sensibly in a diagnostic.
     */
    journeyKey: string;

    // Index
    guildId: string;

    name: string;
    description: string | null;

    /** The declared resources. Validated on every read and write by the repo. */
    resources: JSONColumnType<readonly ResourceDeclaration[]>;

    /**
     * The flow whose authoring created this journey, when there was one.
     *
     * The association lives on this side rather than as a column on `flows`: the flow
     * engine's vocabulary gate rejects `journey`, `resource` and `scope` inside
     * `flows/data`, because the interpreter has no concept of any of them. Pointing
     * the reference this way keeps provisioning depending on flows and never the
     * reverse.
     *
     * Null when no single flow owns it — a journey shared by several flows, which is
     * the grouping case deferred to a later step.
     */
    createdForFlowId: string | null;

    createdAt: ColumnType<Date, string, string>;
    updatedAt: ColumnType<Date, string, string>;
}

export type JourneyEntity = Selectable<JourneyTable>;
export type NewJourneyEntity = Insertable<JourneyTable>;
export type JourneyUpdateEntity = Updateable<JourneyTable>;
