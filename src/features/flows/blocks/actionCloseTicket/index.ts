import { z } from 'zod';
import type { BlockManifest } from '../manifest';
import { ticketingRepo } from '../../../tickets/data/ticketingRepo';
import { isTicketingConfigConfigured } from '../../../tickets/data/ticketingSchema';
import { closeTicket, getTicket } from '../../../tickets';
import { applyTicketTransition } from '../../../tickets/logic/applyTicketTransition';
import { getTicketTypeDefinition } from '../../../tickets/logic/ticketTypes';

export const ACTION_CLOSE_TICKET = 'action.closeTicket';

export const closeTicketConfigSchema = z.object({
    ticketId: z.string().min(1),
});

export type CloseTicketConfig = z.infer<typeof closeTicketConfigSchema>;

/**
 * Closes a ticket the run is holding.
 *
 * Takes the ticket id as a token — normally `{{var.ticketId}}` from an upstream
 * Open Ticket block. A string rather than a number because that is what a
 * rendered token is; it is parsed here and rejected loudly if it is not one,
 * rather than silently closing ticket `NaN`.
 *
 * The id survives a park, which is the practical reason the record has a stable
 * identity separate from its channel: a run can open a ticket, wait days for a
 * human, and still name the same ticket afterwards even if its channel moved
 * category or was renamed in the meantime.
 */
export const block: BlockManifest<CloseTicketConfig> = {
    type: ACTION_CLOSE_TICKET,
    kind: 'action',
    label: 'Close Ticket',
    description: 'Close a ticket this flow opened earlier.',
    group: 'actions',
    icon: '🔒',
    configSchema: closeTicketConfigSchema,
    configFields: [
        {
            key: 'ticketId',
            label: 'Ticket',
            description: 'Usually {{var.ticketId}} from an earlier Open Ticket block.',
            control: 'text',
            placeholder: '{{var.ticketId}}',
            rendersTokens: true,
        },
    ],
    cardSummary: [{ key: 'ticketId', prefix: 'Closes ', emptyText: 'no ticket picked' }],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: [],
    // Closing moves the channel to the closed category and rewrites its
    // permission overwrites, both of which need `manageChannels`.
    capabilities: ['manageChannels'],
    canSuspend: false,
    async run(config, context) {
        const ticketId = Number(config.ticketId);
        // Positivity is the check that matters, not integer-ness. A token that
        // resolved to nothing renders as an empty string, and `Number('')` is
        // `0` — which passes an `isInteger` guard and then fails deep in the
        // service as "no ticket 0", blaming an id the author never wrote.
        if (!Number.isSafeInteger(ticketId) || ticketId <= 0) {
            throw new Error(`Close Ticket needs a ticket id, got "${config.ticketId}"`);
        }

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
        /*
         * Guild-scoped, and the check is this block's own: `getTicket` matches on the id
         * alone. `ticketId` normally arrives as `{{var.ticketId}}` from an upstream Open
         * Ticket block and so belongs to this run's guild — but it is a free-text field a
         * flow author can type a literal into, and nothing downstream would catch it,
         * because the orchestration is handed the row rather than looking it up. Every
         * other surface in this feature makes this check; it would be odd for the one
         * reachable by a typo not to.
         */
        const existing = await getTicket(ticketId);
        if (!existing || existing.guildId !== context.guild.id) {
            throw new Error(`Close Ticket found no ticket with id ${ticketId} in this server`);
        }

        const configEntity = await ticketingRepo.get(context.guild.id);
        const definition = isTicketingConfigConfigured(configEntity)
            ? getTicketTypeDefinition(configEntity.config, existing.type)
            : undefined;

        if (!isTicketingConfigConfigured(configEntity) || !definition) {
            const closed = await closeTicket(ticketId);
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
