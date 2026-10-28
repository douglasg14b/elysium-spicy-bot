import { z } from 'zod';
import type { BlockManifest } from '../manifest';
import type { FlowRunContext } from '../types';
import { ticketingRepo } from '../../../tickets/data/ticketingRepo';
import { isTicketingConfigConfigured } from '../../../tickets/data/ticketingSchema';
import { closeTicket, getTicket, getTicketByChannel, type TicketEntity } from '../../../tickets';
import { applyTicketTransition } from '../../../tickets/logic/applyTicketTransition';
import { getTicketTypeDefinition } from '../../../tickets/logic/ticketTypes';

export const ACTION_CLOSE_TICKET = 'action.closeTicket';

/**
 * Which ticket to close: the one an id names (`id`, typed or `{{var.ticketId}}`), or the one
 * whose channel the run happened in (`here`) — a button pressed under an Open Ticket post, a
 * message sent in the ticket.
 *
 * `id` first: it is the default, and every node saved before the choice existed means it — an
 * unset choice reads as its declared default everywhere, so no migration. Kept in this block's
 * own directory rather than beside the shared channel choice: only this block finds a ticket.
 */
export const CLOSE_TICKET_SOURCES = ['id', 'here'] as const;

/**
 * The ticket id is shown only while the choice is `id` (`visibleWhen`), so it is optional —
 * absent is what it is while hidden — and "required when shown" lives in {@link checkSource}.
 * Still `.min(1)`, so a cleared box is refused as it always was.
 */
export const closeTicketConfigSchema = z
    .object({
        source: z.enum(CLOSE_TICKET_SOURCES).default('id'),
        ticketId: z.string().min(1).optional(),
    })
    .superRefine((config, context) => checkSource(config, context));

export type CloseTicketConfig = z.infer<typeof closeTicketConfigSchema>;

/**
 * Refuse "a ticket ID" with no id at all, under the field. Hidden fields never reach this —
 * save-time validation and the executor leave them out first — so an id left over from before
 * the author switched to "here" is never judged.
 */
function checkSource(config: CloseTicketConfig, context: z.RefinementCtx): void {
    if (config.source === 'id' && config.ticketId === undefined) {
        context.addIssue({
            code: 'custom',
            path: ['ticketId'],
            message: 'Which ticket? Give it an id — or close the ticket in this channel.',
        });
    }
}

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
    configFields: [
        {
            key: 'source',
            label: 'Which ticket',
            description:
                "A ticket by its id, or the one whose channel this happened in — a button pressed under an Open Ticket " +
                "post, a message sent in the ticket. Not after a Schedule or a member joining: there's no channel there.",
            control: 'select',
            defaultValue: 'id',
            options: [
                { value: 'id', label: 'A ticket ID' },
                { value: 'here', label: 'The ticket in this channel', requires: ['channel'] },
            ],
        },
        {
            key: 'ticketId',
            label: 'Ticket',
            description: 'Usually {{var.ticketId}} from an earlier Open Ticket block.',
            control: 'text',
            placeholder: '{{var.ticketId}}',
            rendersTokens: true,
            visibleWhen: { field: 'source', equals: ['id'] },
        },
    ],
    // "Closes {{var.ticketId}}", or "The ticket in this channel" — the hidden id's part
    // renders nothing, so only one of the two ever shows.
    cardSummary: [
        { key: 'source', visibleWhen: { field: 'source', equals: ['here'] } },
        { key: 'ticketId', prefix: 'Closes ', emptyText: 'no ticket picked' },
    ],
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
 * there is none.
 *
 * Guild-scoped either way, and the check is this block's own: `getTicket` matches on the id
 * alone and `getTicketByChannel` on the channel alone. An id normally arrives as
 * `{{var.ticketId}}` from an upstream Open Ticket block and so belongs to this run's guild —
 * but it is a free-text field a flow author can type a literal into, and nothing downstream
 * would catch it, because the orchestration is handed the row rather than looking it up. The
 * run's channel is this guild's by construction, but the row is what the close acts on, so
 * it is the row's guild that is checked, the same way. Every other surface in this feature
 * makes this check; it would be odd for the ones reachable by a typo not to.
 *
 * **No channel on the "here" arm is not a regression.** The executor leaves `channel` to the
 * block (`RUN_CHECKS` in `engine/nodeRequirements.ts`): a channel deleted while the run was
 * parked resumes as nowhere on purpose, and a button pressed in a channel discord.js could not
 * resolve starts a run with none, so that fails by name.
 */
async function ticketToClose(
    config: CloseTicketConfig,
    context: Pick<FlowRunContext, 'guild' | 'channel'>
): Promise<TicketEntity> {
    switch (config.source) {
        case 'id': {
            const ticketId = Number(config.ticketId);
            // Positivity is the check that matters, not integer-ness. A token that
            // resolved to nothing renders as an empty string, and `Number('')` is
            // `0` — which passes an `isInteger` guard and then fails deep in the
            // service as "no ticket 0", blaming an id the author never wrote.
            if (!Number.isSafeInteger(ticketId) || ticketId <= 0) {
                throw new Error(`Close Ticket needs a ticket id, got "${config.ticketId ?? ''}"`);
            }
            const existing = await getTicket(ticketId);
            if (!existing || existing.guildId !== context.guild.id) {
                throw new Error(`Close Ticket found no ticket with id ${ticketId} in this server`);
            }
            return existing;
        }
        case 'here': {
            const { channel } = context;
            if (!channel) {
                throw new Error(
                    "Close Ticket is set to close the ticket in this channel, and this run isn't in a channel the bot " +
                        "can reach — it's gone, walled off, or was never there."
                );
            }
            // A thread counts toward the channel it sits under, as it does everywhere a flow
            // asks about a place (In Channel?, Message Sent): a message in a thread inside the
            // ticket is still in the ticket.
            const ticketChannelId = channel.isThread() && channel.parentId ? channel.parentId : channel.id;
            const existing = await getTicketByChannel(ticketChannelId);
            if (!existing || existing.guildId !== context.guild.id) {
                throw new Error(
                    `Close Ticket went looking for a ticket in this channel (${ticketChannelId}) and came up empty — ` +
                        "this isn't a ticket channel."
                );
            }
            return existing;
        }
        default: {
            const illegal: never = config.source;
            throw new Error(`Unknown ticket source ${JSON.stringify(illegal)}.`);
        }
    }
}
