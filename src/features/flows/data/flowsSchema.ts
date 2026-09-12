import type { ColumnType, Generated, Insertable, JSONColumnType, Selectable, Updateable } from 'kysely';
import type { FlowGraph } from './flowGraph';

/**
 * One row per flow; a guild has many flows. Follows the ticketing JSON-blob
 * precedent — the whole node/edge graph lives in a single JSON column.
 */
export interface FlowTable {
    id: Generated<number>;

    /** Stable public id (crypto.randomUUID), referenced by node custom_ids. */
    flowId: string;

    // Index
    guildId: string;

    name: string;
    enabled: boolean;

    /** The node/edge definition. */
    graph: JSONColumnType<FlowGraph>;

    /** Schema migration marker (matches the existing entityVersion convention). */
    entityVersion: number;

    createdAt: ColumnType<Date, string, string>;
    updatedAt: ColumnType<Date, string, string>;
}

export type FlowEntity = Selectable<FlowTable>;
export type NewFlowEntity = Insertable<FlowTable>;
export type FlowUpdateEntity = Updateable<FlowTable>;
