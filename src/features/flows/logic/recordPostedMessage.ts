import type { Message } from 'discord.js';
import type { MessageButton } from '../../provisioning/logic/messageButtons';
import type { FlowRunContext } from '../blocks/types';
import { flowPostedMessagesRepo } from './flowPostedMessagesRepo';

/** What a block hands over once its message is posted. */
export interface PostedMessage {
    /** The message as Discord answered the send. */
    readonly posted: Pick<Message, 'id' | 'channelId'>;
    /** The buttons it was posted with; none, and there is nothing to record. */
    readonly buttons: readonly MessageButton[];
    /** The run that posted it. */
    readonly context: Pick<FlowRunContext, 'guild' | 'flowId' | 'nodeId' | 'runId' | 'subject'>;
    /** The ticket whose channel it is in — Open Ticket's own. */
    readonly ticketId?: number;
}

/**
 * Write down a message a block just posted, when it carries buttons, so a press on one can be
 * routed back to the flow that posted it (`flow_posted_messages`). A message without buttons
 * has nothing to press and is not recorded.
 *
 * **Logged, never thrown.** The message is posted and the flow did its job; failing the run
 * now would read as the post having failed. A message whose record is missing keeps buttons
 * that answer "Nothing's hooked up to this yet" — the answer every press gets in step 1.
 */
export async function recordPostedMessage({ posted, buttons, context, ticketId }: PostedMessage): Promise<void> {
    if (buttons.length === 0) return;

    try {
        await flowPostedMessagesRepo.create({
            messageId: posted.id,
            guildId: context.guild.id,
            channelId: posted.channelId,
            flowId: context.flowId,
            nodeId: context.nodeId,
            runId: context.runId,
            subjectId: context.subject?.id ?? null,
            ticketId: ticketId ?? null,
            postedAt: new Date().toISOString(),
        });
    } catch (error) {
        console.error(
            `[flows] Posted message ${posted.id} (flow ${context.flowId}, node ${context.nodeId}) carries buttons, but recording it failed — its buttons will never find this flow:`,
            error
        );
    }
}
