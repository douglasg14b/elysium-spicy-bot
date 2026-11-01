import { z } from 'zod';
import type { BlockManifest } from '../manifest';
import type { FlowRunContext } from '../types';
import {
    checkTicketChoice,
    findChosenTicket,
    TICKET_CHOICE_CARD_PART,
    TICKET_CHOICE_FIELD,
    TICKET_ID_FIELD,
    ticketChoiceShape,
} from '../../logic/ticketChoice';
import { ticketingRepo } from '../../../tickets/data/ticketingRepo';
import { isTicketingConfigConfigured } from '../../../tickets/data/ticketingSchema';
import { closeTicket, type TicketEntity } from '../../../tickets';
import { applyTicketTransition } from '../../../tickets/logic/applyTicketTransition';
import { getTicketTypeDefinition } from '../../../tickets/logic/ticketTypes';

export const ACTION_CLOSE_TICKET = 'action.closeTicket';

/** Which ticket to close — the shared "Which ticket" choice (`logic/ticketChoice.ts`). */
export const closeTicketConfigSchema = z
    .object(ticketChoiceShape)
    .superRefine((config, context) => checkTicketChoice(config, context));

export type CloseTicketConfig = z.infer<typeof closeTicketConfigSchema>;

/**
 * Closes a ticket: one the run names by id, or the one whose channel it happened in.
 *
 * The id normally arrives as a token — `{{var.ticketId}}` from an upstream Open Ticket
 * block. A string rather than a number because that is what a rendered token is; it is
 * parsed here and rejected loudly if it is not one, rather than silently closing ticket
 * `NaN`.
 *
 * The id survives a park, which is the practical reason the record has a stable
 * identity separate from its channel: a run can open a ticket, wait days for a
 * human, and still name the same ticket afterwards even if its channel moved
 * category or was renamed in the meantime.
 *
 * "The ticket in this channel" needs the run's channel (the option's `requires`), so it is
 * refused at save below a trigger that happens nowhere in particular and greyed in the
 * builder there. The ticket is looked up by that channel each time the block runs.
 */
export const block: BlockManifest<CloseTicketConfig> = {
    type: ACTION_CLOSE_TICKET,
    kind: 'action',
    label: 'Close Ticket',
    description: 'Shut a ticket — the one this happened in, or one this flow opened earlier.',
    group: 'actions',
    icon: '🔒',
    configSchema: closeTicketConfigSchema,
    configFields: [TICKET_CHOICE_FIELD, TICKET_ID_FIELD],
    // "Closes {{var.ticketId}}", or "The ticket in this channel" — the hidden id's part
    // renders nothing, so only one of the two ever shows.
    cardSummary: [TICKET_CHOICE_CARD_PART, { key: 'ticketId', prefix: 'Closes ', emptyText: 'no ticket picked' }],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: [],
    // Closing moves the channel to the closed category and rewrites its
    // permission overwrites, both of which need `manageChannels`.
    capabilities: ['manageChannels'],
    /*
     * The ticket it closes is announced as closed. Its type is not carried: the ticket is
     * a `{{var}}` the run fills in, so which type it is cannot be known before it runs —
     * left unknown, it starts every Ticket Event listening for closed, whatever type that
     * trigger filters on. Over-refusing is the accepted cost of not missing a loop.
     */
    emits: [{ startedBy: 'ticketChanged', carries: { event: { value: 'closed' } } }],
    canSuspend: false,
    async run(config, context) {
        const existing = await ticketToClose(config, context);
        const ticketId = existing.id;

        /*
         * The close goes through the same orchestration the dashboard and the four
         * buttons use, so this block stopped being a fifth copy of
         * commit-then-sync-then-warn. That means the config and the type definition
         * have to be resolved *first*, because the orchestration takes both — where
         * the old code closed the row and only then went looking for a config.
         *
         * The fallback is unchanged and deliberate: a guild with no usable ticket
         * config, or a ticket holding a type it no longer declares, still gets the
         * row closed. The record is the truth and the channel is one of its
         * renderings, so a flow must not be blocked from closing a ticket because
         * the guild's *presentation* config has rotted. What is lost in that case is
         * the channel move, which is what the old code lost too.
         */
        const configEntity = await ticketingRepo.get(context.guild.id);
        const definition = isTicketingConfigConfigured(configEntity)
            ? getTicketTypeDefinition(configEntity.config, existing.type)
            : undefined;

        // A flow made this change, so the bot is who acted (`guild.client` is the ready
        // client, so its user is never null) — and it sits at this run's depth, so a flow
        // the close starts is one link further down the chain and the cap holds.
        const change = { actorId: context.guild.client.user.id, chainDepth: context.chainDepth };

        if (!isTicketingConfigConfigured(configEntity) || !definition) {
            const closed = await closeTicket(ticketId, change);
            if (!closed.ok) throw closed.error;
            return { kind: 'continue' };
        }

        const result = await applyTicketTransition({
            guild: context.guild,
            config: configEntity.config,
            ticket: existing,
            definition,
            transition: 'close',
            // A flow has no human actor. Named as the automation rather than left
            // blank, because the in-channel announcement is read by the people in the
            // ticket and "closed by" with nothing after it reads like a bug.
            actor: { id: context.client.user?.id ?? 'flow', mention: 'an automated flow', identity: null },
            change,
        });

        // Thrown rather than swallowed: the block's contract is that the ticket is
        // closed when it continues, and the service's refusals are the reasons it is
        // not — already closed, already deleted, changed state underneath.
        if (!result.ok) throw new Error(result.message);

        if (result.outcome.syncWarning) {
            // Nowhere to reply to in a flow run, so it is logged rather than
            // surfaced. The row is committed either way.
            console.warn(`[flows] ${ACTION_CLOSE_TICKET}: ${result.outcome.syncWarning}`);
        }

        return { kind: 'continue' };
    },
};

/**
 * The ticket the node's choice names, **in this run's guild** — or a thrown error naming why
 * there is none. An action cannot close what is not there, so not finding one fails the run.
 *
 * The guild check is `findChosenTicket`'s, and it matters here more than anywhere: nothing
 * downstream would catch another server's ticket, because the orchestration is handed the row
 * rather than looking it up.
 */
async function ticketToClose(
    config: CloseTicketConfig,
    context: Pick<FlowRunContext, 'guild' | 'channel'>
): Promise<TicketEntity> {
    const chosen = await findChosenTicket(config, context, 'Close Ticket');
    switch (chosen.kind) {
        case 'found':
            return chosen.ticket;
        case 'noTicketWithId':
            throw new Error(`Close Ticket found no ticket with id ${chosen.ticketId} in this server`);
        case 'noTicketInChannel':
            throw new Error(
                `Close Ticket went looking for a ticket in this channel (${chosen.channelId}) and came up empty — ` +
                    "this isn't a ticket channel."
            );
        default: {
            const illegal: never = chosen;
            throw new Error(`Unknown ticket lookup ${JSON.stringify(illegal)}.`);
        }
    }
}
