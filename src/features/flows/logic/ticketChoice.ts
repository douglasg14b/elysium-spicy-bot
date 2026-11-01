import { z } from 'zod';
import type { BlockCardSummaryPart, BlockConfigField } from '../blocks/manifest';
import type { FlowRunContext } from '../blocks/types';
import { getTicket, getTicketByChannel, type TicketEntity } from '../../tickets';

/**
 * Which ticket a block means: the one an id names (`id`, typed or `{{var.ticketId}}`), or the
 * one whose channel the run happened in (`here`) — a button pressed under an Open Ticket post,
 * a message sent in the ticket.
 *
 * `id` first: it is the default, and every Close Ticket node saved before the choice existed
 * means it — an unset choice reads as its declared default everywhere, so no migration. Shared
 * by the blocks that find one ticket (Close Ticket, Ticket Status?), so they cannot come to
 * find it differently. In `logic/` rather than beside `blocks/channelChoice.ts`, because the
 * engine vocabulary gate scans `blocks/*.ts` and `ticket` is not engine vocabulary.
 */
export const TICKET_SOURCES = ['id', 'here'] as const;

/**
 * The choice's piece of a block's config schema, spread into its `z.object`.
 *
 * The ticket id is shown only while the choice is `id` (`visibleWhen`), so it is optional —
 * absent is what it is while hidden — and "required when shown" lives in
 * {@link checkTicketChoice}. Still `.min(1)`, so a cleared box is refused as it always was.
 */
export const ticketChoiceShape = {
    source: z.enum(TICKET_SOURCES).default('id'),
    ticketId: z.string().min(1).optional(),
};

/** What {@link checkTicketChoice} and {@link findChosenTicket} read off a parsed config — derived, so it cannot drift from the shape. */
export type TicketChoiceConfig = Readonly<z.output<z.ZodObject<typeof ticketChoiceShape>>>;

/**
 * Refuse "a ticket ID" with no id at all, under the field — for the block's own `superRefine`.
 * Hidden fields never reach this — save-time validation and the executor leave them out
 * first — so an id left over from before the author switched to "here" is never judged.
 */
export function checkTicketChoice(config: TicketChoiceConfig, context: z.RefinementCtx): void {
    if (config.source === 'id' && config.ticketId === undefined) {
        context.addIssue({
            code: 'custom',
            path: ['ticketId'],
            message: 'Which ticket? Give it an id — or use the ticket in this channel.',
        });
    }
}

/**
 * The "Which ticket" field. "The ticket in this channel" needs the run's channel (the
 * option's `requires`), so it is refused at save below a trigger that happens nowhere in
 * particular and greyed in the builder there.
 */
export const TICKET_CHOICE_FIELD = {
    key: 'source',
    label: 'Which ticket',
    description:
        'A ticket by its id, or the one whose channel this happened in — a button pressed under an Open Ticket ' +
        "post, a message sent in the ticket. Not after a Schedule or a member joining: there's no channel there.",
    control: 'select',
    defaultValue: 'id',
    options: [
        { value: 'id', label: 'A ticket ID' },
        { value: 'here', label: 'The ticket in this channel', requires: ['channel'] },
    ],
} as const satisfies BlockConfigField;

/** The id box, shown only while the choice is "a ticket ID". */
export const TICKET_ID_FIELD = {
    key: 'ticketId',
    label: 'Ticket',
    description: 'Usually {{var.ticketId}} from an earlier Open Ticket block or a Ticket Event trigger.',
    control: 'text',
    placeholder: '{{var.ticketId}}',
    rendersTokens: true,
    visibleWhen: { field: TICKET_CHOICE_FIELD.key, equals: ['id'] },
} as const satisfies BlockConfigField;

/**
 * The card part naming the choice, shown only while it is not the default — the id's part
 * renders nothing while the box is hidden, so exactly one of the two speaks. Placed before
 * the id's part, so it leads the line.
 */
export const TICKET_CHOICE_CARD_PART = {
    key: TICKET_CHOICE_FIELD.key,
    visibleWhen: { field: TICKET_CHOICE_FIELD.key, equals: ['here'] },
} as const satisfies BlockCardSummaryPart;

/** The ticket a choice names, or what was looked for and not found in this guild. */
export type ChosenTicket =
    | { readonly kind: 'found'; readonly ticket: TicketEntity }
    | { readonly kind: 'noTicketWithId'; readonly ticketId: number }
    | { readonly kind: 'noTicketInChannel'; readonly channelId: string };

/**
 * Find the ticket the node's choice names, **in this run's guild**.
 *
 * Not finding one is an answer, returned, so a condition can branch on it and an action can
 * refuse it in its own words. What is thrown is a node that can never find anything: an id
 * that is not one (a token that rendered to nothing reads as `0`), or a run with no channel to
 * look in.
 *
 * Guild-scoped either way, and the check is this function's: `getTicket` matches on the id
 * alone and `getTicketByChannel` on the channel alone. An id normally arrives as
 * `{{var.ticketId}}` and so belongs to this run's guild — but it is a free-text field a flow
 * author can type a literal into. A deleted ticket is found by its id (the record outlives its
 * channel) and never by a channel (`getTicketByChannel` leaves deleted tickets out).
 *
 * **No channel on the "here" arm is not a regression.** The executor leaves `channel` to the
 * block (`RUN_CHECKS` in `engine/nodeRequirements.ts`): a channel deleted while the run was
 * parked resumes as nowhere on purpose, and a button pressed in a channel discord.js could not
 * resolve starts a run with none, so that fails by name.
 *
 * @param blockLabel The block's own label, for the thrown errors.
 */
export async function findChosenTicket(
    config: TicketChoiceConfig,
    context: Pick<FlowRunContext, 'guild' | 'channel'>,
    blockLabel: string
): Promise<ChosenTicket> {
    switch (config.source) {
        case 'id': {
            const ticketId = Number(config.ticketId);
            // Positivity is the check that matters, not integer-ness. A token that
            // resolved to nothing renders as an empty string, and `Number('')` is
            // `0` — which passes an `isInteger` guard and then reads as "no ticket 0",
            // blaming an id the author never wrote.
            if (!Number.isSafeInteger(ticketId) || ticketId <= 0) {
                throw new Error(`${blockLabel} needs a ticket id, got "${config.ticketId ?? ''}"`);
            }
            const ticket = await getTicket(ticketId);
            return ticket && ticket.guildId === context.guild.id
                ? { kind: 'found', ticket }
                : { kind: 'noTicketWithId', ticketId };
        }
        case 'here': {
            const { channel } = context;
            if (!channel) {
                throw new Error(
                    `${blockLabel} is set to use the ticket in this channel, and this run isn't in a channel the bot ` +
                        "can reach — it's gone, walled off, or was never there."
                );
            }
            // A thread counts toward the channel it sits under, as it does everywhere a flow
            // asks about a place (In Channel?, Message Sent): a message in a thread inside the
            // ticket is still in the ticket.
            const channelId = channel.isThread() && channel.parentId ? channel.parentId : channel.id;
            const ticket = await getTicketByChannel(channelId);
            return ticket && ticket.guildId === context.guild.id
                ? { kind: 'found', ticket }
                : { kind: 'noTicketInChannel', channelId };
        }
        default: {
            const illegal: never = config.source;
            throw new Error(`Unknown ticket source ${JSON.stringify(illegal)}.`);
        }
    }
}
