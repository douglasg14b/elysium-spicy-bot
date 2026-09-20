import type { ColumnType, Generated, Insertable, JSONColumnType, Selectable, Updateable } from 'kysely';

/**
 * One row per message carrying a flow's trigger buttons.
 *
 * Nothing recorded where those buttons went until this table existed. `deployFlowButtons`
 * posted a message, returned its id, and both callers dropped it — so deleting a flow
 * left live buttons in a channel pointing at a flow that no longer existed, with nothing
 * able to find them. That is the gap this closes.
 *
 * **A list, not a column on `flows`.** One flow may have its buttons posted in several
 * channels, and a column would silently keep only the last one — which is the same
 * shape of bug as not recording it at all, just harder to notice.
 *
 * ## The name
 *
 * Called *button messages* rather than *deployments* because this directory is inside
 * the engine's vocabulary gate (`flows/__tests__/engineVocabulary.test.ts`), which is an
 * allowlist: every word a declared identifier uses must already be engine vocabulary.
 * `deploy` is not, and widening the list is the move that file exists to discourage.
 *
 * Every word here — flow, button, message, channel, node, guild — was already engine
 * vocabulary, because the thing being described really is just "a message that carries
 * buttons". The constraint produced the more literal name, which is the better one: a
 * deployment is a process, and what is stored is an artefact.
 */
export interface FlowButtonMessageTable {
    id: Generated<number>;

    // Index: (guildId, flowId) is how both undeploy and the published lookup read this.
    guildId: string;
    flowId: string;

    channelId: string;

    /** The posted message carrying the buttons. Deleting it is what retires them. */
    messageId: string;

    /**
     * Which trigger nodes this message's buttons fire, at the time it was posted.
     *
     * Recorded rather than re-derived from the graph, because the graph changes: a
     * node deleted after the message was posted would make the live button
     * unexplainable, and this is what lets a listing say honestly which buttons a
     * given message still carries.
     */
    nodeIds: JSONColumnType<string[]>;

    createdAt: ColumnType<Date, string, string>;
    updatedAt: ColumnType<Date, string, string>;
}

export type FlowButtonMessageEntity = Selectable<FlowButtonMessageTable>;
export type NewFlowButtonMessageEntity = Insertable<FlowButtonMessageTable>;
export type FlowButtonMessageUpdateEntity = Updateable<FlowButtonMessageTable>;
