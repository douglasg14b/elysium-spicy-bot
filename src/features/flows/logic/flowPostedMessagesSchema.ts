import type { ColumnType, Insertable, Selectable } from 'kysely';

/**
 * One row per message a flow's block posted carrying buttons — Post Embed's, or the message
 * Open Ticket puts in its ticket channel above the card.
 *
 * **Why a record at all.** A journey's message is found from a press through its binding
 * (`resource_bindings.message_id`); a block's message has none, is never reposted, and its
 * buttons' customIds are `mbtn:<buttonKey>` alone — 100 characters cannot also carry the
 * flow, the node and the member. So the post is written down as it happens, and a press can
 * be routed from here once something listens (step 2 of
 * `docs/plans/block-message-buttons-step-1.md`). Until then a press answers "Nothing's hooked
 * up to this yet" and nothing reads this table. Without it, every message posted before step
 * 2 would carry buttons deaf for good.
 *
 * **Only messages with buttons**, written after the send succeeded and never in its way: a
 * failed write is logged (`recordPostedMessage`), since the message is posted and the flow did
 * what it was asked.
 *
 * ## Why this lives in `logic/`, not `data/`
 *
 * `ticketId` is a member, and `ticket` is a proven rejection of the engine vocabulary gate
 * (`flows/__tests__/engineVocabulary.test.ts`), which reads every declaration under `data/`.
 * The same reason `logic/ticketEventDispatch.ts` is not under `engine/`.
 */
export interface FlowPostedMessageTable {
    /** The posted message, by its Discord id. The primary key: a press arrives naming it. */
    messageId: string;

    guildId: string;
    channelId: string;

    /** The flow, node and run that posted it. */
    flowId: string;
    nodeId: string;
    runId: string;

    /** Who the posting run was about; null for a run about nobody (a Schedule's). */
    subjectId: string | null;

    /** The ticket Open Ticket opened, whose channel this is in; null for every other block. */
    ticketId: number | null;

    postedAt: ColumnType<Date, string, string>;
}

export type FlowPostedMessageEntity = Selectable<FlowPostedMessageTable>;
export type NewFlowPostedMessageEntity = Insertable<FlowPostedMessageTable>;
