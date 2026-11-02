import type { BlockOutputDeclaration } from '../blocks/manifest';
import type { FlowRunContext } from '../blocks/types';
import { TICKET_VARIABLES } from '../../tickets';

/**
 * Who a ticket is for, as variables: the declaration and the write, shared by the blocks that
 * find a ticket (Has Open Ticket?, Ticket Status?) so they cannot come to name or word it
 * differently.
 *
 * This is how a run reaches the ticket's member when its own subject is somebody else — a mod
 * pressing a button inside a ticket is the subject of that run. `{{var.ticketSubjectMention}}`
 * pings them; `{{var.ticketSubjectId}}` is the raw id. In `logic/` rather than `blocks/`
 * because the engine vocabulary gate scans `blocks/*.ts` and `ticket` is not engine vocabulary.
 */

/**
 * The two outputs, written on each of `handles` — the exits where a ticket was found. One
 * declaration per handle because an output scopes to a single exit (`handle`); the builder
 * offers the name wherever any of them is on the path.
 */
export function ticketSubjectOutputs(handles: readonly string[]): readonly BlockOutputDeclaration[] {
    return handles.flatMap((handle): readonly BlockOutputDeclaration[] => [
        {
            naming: 'fixed',
            key: TICKET_VARIABLES.ticketSubjectId,
            label: 'Ticket member ID',
            description: 'Who the ticket is for.',
            handle,
        },
        {
            naming: 'fixed',
            key: TICKET_VARIABLES.ticketSubjectMention,
            label: 'Ticket member mention',
            description: 'A ping for who the ticket is for, ready to drop into a message.',
            handle,
        },
    ]);
}

/** Record who the ticket is for. Written on every visit, so an earlier ticket's member cannot survive to pair with this one. */
export function writeTicketSubjectOutputs(context: Pick<FlowRunContext, 'setOutput'>, subjectId: string): void {
    context.setOutput(TICKET_VARIABLES.ticketSubjectId, subjectId);
    context.setOutput(TICKET_VARIABLES.ticketSubjectMention, `<@${subjectId}>`);
}
