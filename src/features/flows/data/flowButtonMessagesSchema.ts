import type { ColumnType, Generated, Insertable, JSONColumnType, Selectable, Updateable } from 'kysely';

/**
 * One row per message the retired Deploy posted carrying a flow's trigger buttons.
 *
 * **Kept, unread, until the bridge-removal deploy** (`docs/plans/message-resource-step-3.md`,
 * "After this step"). Nothing writes it any more and no code path reads it: step 3's
 * migration reads it once, to adopt each posted message as a journey's message resource,
 * and the bridge-removal deploy drops the table with this file and its `Database` entry.
 *
 * **A list, not a column on `flows`.** One flow may have had its buttons posted in several
 * channels, which is why the migration finds one message per channel here.
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

    // Index: (guildId, flowId), from when undeploy and the published lookup read this.
    guildId: string;
    flowId: string;

    channelId: string;

    /** The posted message carrying the buttons. */
    messageId: string;

    /**
     * Which trigger nodes this message's buttons fire, at the time it was posted.
     *
     * Recorded rather than re-derived from the graph, because the graph changes: a
     * node deleted after the message was posted would make the live button
     * unexplainable. The migration reads it to match each posted message to the
     * Button Click nodes it carried.
     */
    nodeIds: JSONColumnType<string[]>;

    createdAt: ColumnType<Date, string, string>;
    updatedAt: ColumnType<Date, string, string>;
}

export type FlowButtonMessageEntity = Selectable<FlowButtonMessageTable>;
export type NewFlowButtonMessageEntity = Insertable<FlowButtonMessageTable>;
export type FlowButtonMessageUpdateEntity = Updateable<FlowButtonMessageTable>;
