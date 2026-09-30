import type { ColumnType, Generated, JSONColumnType, Selectable } from 'kysely';
import type { FlowGraph } from './flowGraph';

/**
 * One operator's unsaved canvas for one flow.
 *
 * A draft is the answer to "I can't finish this in one sitting": the builder autosaves
 * the canvas here while it has unsaved changes, and a save that would put an incomplete
 * graph on a **live** flow lands here instead of on the flow. It is never run — the
 * executor reads `flows.graph` and nothing else — so the only rule its graph has to
 * satisfy is the structural one, the same check `flows` applies.
 *
 * **At most one per operator per flow** (unique on `(flowId, authorId)`). Several
 * operators may each hold one, and the builder shows them all on open and lets the
 * operator pick; there are no merge rules, by design.
 */
export interface FlowDraftTable {
    /** Surrogate key, and the id the dashboard names a draft by when discarding it. */
    id: Generated<number>;

    /** The flow this is a draft of, by `flows.flowId`. Deleted with it. */
    flowId: string;

    /** Copied from the flow, so a draft is guild-scoped without a join. */
    guildId: string;

    /** The Discord user whose canvas this is. */
    authorId: string;

    /**
     * The author's username **when the draft was last written**, for the picker's
     * "@alice's draft". A snapshot rather than a lookup: the picker must not need a
     * Discord fetch per row, and a stale name on a draft is harmless.
     */
    authorName: string;

    /** The flow name as the canvas had it — a rename is part of the unsaved work. */
    name: string;

    graph: JSONColumnType<FlowGraph>;

    /**
     * The flow version this draft's canvas descends from: the flow's `updatedAt` when its
     * author loaded it (or the base of a draft they loaded instead), as the builder
     * reports it.
     *
     * What lets the picker say "the flow has been saved since" — the thing an operator
     * needs to know before loading a draft over someone else's newer save.
     */
    baseUpdatedAt: ColumnType<Date, string, string>;

    createdAt: ColumnType<Date, string, string>;
    updatedAt: ColumnType<Date, string, string>;
}

export type FlowDraftEntity = Selectable<FlowDraftTable>;
