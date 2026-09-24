import { z } from 'zod';
import type { BlockManifest } from '../manifest';
import { attachTicketChannel, openTicket, recordTicketStateMessage } from '../../../tickets';
import { ticketingRepo } from '../../../tickets/data/ticketingRepo';
import { isTicketingConfigConfigured } from '../../../tickets/data/ticketingSchema';
import { createTicketChannelForTicket } from '../../../tickets/logic/ticketChannelOps';
import { buildTicketButtons, buildTicketEmbed } from '../../../tickets/logic/ticketPresentation';
import { getTicketTypeDefinition } from '../../../tickets/logic/ticketTypes';
import { ticketIdentityFromMember } from '../../../tickets/logic/resolveTicketIdentity';

export const ACTION_OPEN_TICKET = 'action.openTicket';

export const openTicketConfigSchema = z.object({
    // Free text rather than an enum: a ticket type is a row in the guild's
    // `ticketing_config` now, so a closed union in source would reject every type an
    // operator declares. The `options` below stay the two seeded keys until the
    // picker learns to read the guild's own list — `checkFieldChoices` requires a
    // `select` to offer non-empty options, so they cannot simply be emptied here.
    ticketType: z.string().min(1),
    title: z.string().min(1).max(100),
    // Optional rather than defaulted: a schema default the builder does not also
    // declare produces a node whose key is simply unset, which the conformance
    // gate rightly refuses. Absent and empty mean the same thing to `run`.
    reason: z.string().max(1000).optional(),
});

export type OpenTicketConfig = z.infer<typeof openTicketConfigSchema>;

/**
 * Opens a ticket for the subject and hands its channel to later blocks.
 *
 * A thin adapter, and deliberately so: it decides nothing. Numbering, the
 * permission model, whether the type auto-claims, and what "open" means all live
 * in the ticket service, where they are testable without a gateway and reachable
 * by the mod-facing commands too. This block only supplies the subject and
 * carries the result back into the run.
 *
 * `openerId` is null here — a flow opened this, no human filed it. That case did
 * not previously exist: the old creation path read its opener out of
 * `interaction.user` and always auto-claimed to them, so a flow-opened ticket
 * could not be represented at all.
 */
export const block: BlockManifest<OpenTicketConfig> = {
    type: ACTION_OPEN_TICKET,
    kind: 'action',
    label: 'Open Ticket',
    description: 'Open a ticket for them, and keep hold of the channel it made.',
    group: 'actions',
    icon: '🎫',
    configSchema: openTicketConfigSchema,
    configFields: [
        {
            key: 'ticketType',
            label: 'Ticket type',
            description: 'Decides the category, the channel name, and who can see it.',
            control: 'select',
            options: [
                { value: 'support', label: 'Support' },
                { value: 'verification', label: 'Verification' },
            ],
        },
        {
            key: 'title',
            label: 'Title',
            control: 'text',
            placeholder: 'What this ticket is about',
            maxLength: 100,
            rendersTokens: true,
        },
        {
            key: 'reason',
            label: 'Reason',
            control: 'longText',
            placeholder: 'Any extra context for whoever picks this up…',
            maxLength: 1000,
            rendersTokens: true,
        },
    ],
    cardSummary: [
        { key: 'ticketType', emptyText: 'no type picked' },
        { key: 'title', prefix: ' · ', quote: true, truncate: 20, hideWhenEmpty: true },
    ],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [
        {
            naming: 'fixed',
            key: 'ticketId',
            label: 'Ticket ID',
            description: 'The opened ticket, so a later block can close or post to it.',
        },
        {
            naming: 'fixed',
            key: 'ticketChannelId',
            label: 'Ticket channel',
            description: 'The channel that was created for the ticket.',
        },
    ],
    requires: ['subject'],
    // `manageChannels` because opening a ticket creates a channel, and may
    // create its category. The most channel-hungry block in the tree, so it is
    // the one that would silently pass when capability checking lands.
    capabilities: ['sendMessages', 'embedLinks', 'manageChannels'],
    // The builder previews the channel name from this; `title` does not decide it.
    createsChannel: true,
    canSuspend: false,
    async run(config, context) {
        const configEntity = await ticketingRepo.get(context.guild.id);
        // Thrown rather than returned as a failure handle: a flow configured to
        // open tickets in a guild with no ticket system is an authoring mistake
        // that should be loud, not a path the author is expected to branch on.
        if (!isTicketingConfigConfigured(configEntity)) {
            throw new Error(`Ticketing is not configured for guild ${context.guild.id}`);
        }

        // Thrown for the same reason as the configuration check above: a flow
        // configured to open a type the guild does not declare is an authoring
        // mistake, loud rather than a path the author is expected to branch on.
        const definition = getTicketTypeDefinition(configEntity.config, config.ticketType);
        if (!definition) {
            throw new Error(
                `Guild ${context.guild.id} declares no ticket type "${config.ticketType}"`
            );
        }

        const ticketResult = await openTicket({
            guildId: context.guild.id,
            type: config.ticketType,
            definition,
            subjectId: context.subject.id,
            openerId: null,
            title: config.title,
            reason: config.reason || 'Opened automatically by a flow',
            // `context.subject` is already a `GuildMember`, so this costs no fetch.
            // The opener is null — a flow filed this — so there is no opener to name.
            subjectIdentity: ticketIdentityFromMember(context.subject),
            openerIdentity: null,
        });
        if (!ticketResult.ok) throw ticketResult.error;
        const ticket = ticketResult.value;

        const channelResult = await createTicketChannelForTicket({
            guild: context.guild,
            ticket,
            config: configEntity.config,
            subjectName: context.subject.user.username,
            openerName: null,
        });
        // The record survives a channel that could not be created, holding
        // `channelId` null. That is the point of the record being the ticket:
        // the alternative — the old model — had nowhere to put a half-made one.
        if (!channelResult.ok) throw channelResult.error;
        const channel = channelResult.value;

        const attached = await attachTicketChannel(ticket.id, channel.id);
        if (!attached.ok) throw attached.error;

        const message = await channel.send({
            content: `<@${ticket.subjectId}>`,
            embeds: [buildTicketEmbed(attached.value, definition)],
            components: buildTicketButtons(attached.value),
            allowedMentions: { parse: ['users'] },
        });

        // Recorded so a caller with no interaction can re-render this embed. Logged
        // rather than thrown: the row is the ticket and the flow has already done the
        // thing it was asked to do.
        const stateMessage = await recordTicketStateMessage(attached.value.id, message.id);
        if (!stateMessage.ok) {
            console.error('[action.openTicket] Failed to record ticket state message id:', stateMessage.error);
        }

        // Pinning is a convenience now, not load-bearing. Under the old design
        // the pinned message *was* the ticket's only state, so failing to pin
        // put it one unpin away from being unresolvable.
        await message.pin().catch(() => undefined);

        context.setOutput('ticketId', ticket.id);
        context.setOutput('ticketChannelId', channel.id);

        return { kind: 'continue' };
    },
};
