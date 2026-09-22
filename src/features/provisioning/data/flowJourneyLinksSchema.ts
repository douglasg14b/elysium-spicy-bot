import type { ColumnType, Generated, Selectable } from 'kysely';

/**
 * One row per flow that is attached to a journey.
 *
 * The association that lets a journey hold **more than one flow**. Until this table
 * existed the relationship was a naming convention — a flow's journey was the journey
 * whose key equalled the flow's own id — which can express exactly one flow per
 * journey and nothing else.
 *
 * **Why a third table and not a `journeys` column.** `journeys.createdForFlowId` is
 * singular, so it cannot hold a list; widening it to JSON would make the journey row
 * the owner of a list that no constraint protects, admitting a flow twice or in two
 * journeys. The reference therefore points flow → journey, which is the direction the
 * cardinality actually runs.
 *
 * **Why not a column on `flows`.** The flow engine's vocabulary gate
 * (`engineVocabulary.test.ts`) rejects `journey` inside `flows/data`, and it is right
 * to: the interpreter executes a graph whose node configs already hold ids and has no
 * concept of a journey, a resource or a scope. Renaming the concept to slip past the
 * gate is the leak the gate exists to catch. Keeping the noun here also preserves the
 * one-way dependency `dependencyDirection.test.ts` enforces — provisioning may read
 * flows, flows may never read provisioning.
 *
 * Deliberately **not** a foreign key, for the same reason `journeys` is not: journey
 * keys are unique per guild rather than globally, so a single-column FK has nothing to
 * reference and a composite one would make sqlite's rebuild-on-alter markedly more
 * fragile for enforcement the repo already does on write.
 */
export interface FlowJourneyLinkTable {
    id: Generated<number>;

    /**
     * Scopes both sides. A journey key is unique per guild, not globally, so neither
     * column means anything without it.
     */
    guildId: string;

    /**
     * The attached flow, by `flows.flowId` (a UUID, not the surrogate `flows.id`).
     *
     * Unique within a guild: **one flow has at most one journey.** That is a schema
     * constraint rather than prose because it is the invariant every lookup assumes.
     */
    flowId: string;

    /** The journey the flow installs, by `journeys.journeyKey` within the same guild. */
    journeyKey: string;

    createdAt: ColumnType<Date, string, string>;
    updatedAt: ColumnType<Date, string, string>;
}

export type FlowJourneyLinkEntity = Selectable<FlowJourneyLinkTable>;
