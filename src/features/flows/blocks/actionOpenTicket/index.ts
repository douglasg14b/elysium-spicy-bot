import type { Guild } from 'discord.js';
import { z } from 'zod';
import { messageConfigSchema, trimMessageText } from '../../../../shared/discordMessage';
import { messageButtonsConfigSchema } from '../../../provisioning/logic/messageButtonSchema';
import { recordPostedMessage } from '../../logic/recordPostedMessage';
import type { BlockManifest } from '../manifest';
import { messageWithButtons, renderedMessageIssue, type MessageWithButtons } from '../messageWithButtons';
import { requireSubject } from '../types';
import { attachTicketChannel, openTicket, recordTicketStateMessage, TICKET_VARIABLES } from '../../../tickets';
import { ticketingRepo } from '../../../tickets/data/ticketingRepo';
import { isTicketingConfigConfigured } from '../../../tickets/data/ticketingSchema';
import { createTicketChannelForTicket } from '../../../tickets/logic/ticketChannelOps';
import { buildTicketButtons, buildTicketEmbed } from '../../../tickets/logic/ticketPresentation';
import { getTicketTypeDefinition } from '../../../tickets/logic/ticketTypes';
import { ticketIdentityFromMember } from '../../../tickets/logic/resolveTicketIdentity';

export const ACTION_OPEN_TICKET = 'action.openTicket';

/** The message field's label: what the form shows, and what every failure names a part by. */
const MESSAGE_LABEL = 'Message';

/** Buttons with no message: they need something to sit under, as a journey message's do. */
const BUTTONS_WITHOUT_MESSAGE =
    "Buttons need a message to hang off — give it some words or an embed, or bin the buttons.";

export const openTicketConfigSchema = z
    .object({
        // Free text rather than an enum: a ticket type is a row in the guild's
        // `ticketing_config`, so a closed union in source would reject every type an
        // operator declares. The picker offers the guild's own list; a key it no longer
        // declares fails the run by name below.
        ticketType: z.string().min(1),
        title: z.string().min(1).max(100),
        // Optional rather than defaulted: a schema default the builder does not also
        // declare produces a node whose key is simply unset, which the conformance
        // gate rightly refuses. Absent and empty mean the same thing to `run`.
        reason: z.string().max(1000).optional(),
        // The flow's own message, posted in the ticket channel above the ticket card, and
        // the buttons under it (the field's `buttonsKey`). Both optional: unset posts the
        // card alone, as every node saved before these existed does.
        message: messageConfigSchema.optional(),
        buttons: messageButtonsConfigSchema.optional(),
    })
    .superRefine((config, context) => {
        if (!config.message && (config.buttons?.length ?? 0) > 0) {
            context.addIssue({ code: 'custom', path: ['buttons'], message: BUTTONS_WITHOUT_MESSAGE });
        }
    });

export type OpenTicketConfig = z.infer<typeof openTicketConfigSchema>;

/**
 * The flow's message as it will be sent, or why it cannot be — judged and its uploads read
 * before any ticket exists, so a message that can never post allocates no number, makes no
 * row and no channel. `undefined` when the node has no message.
 */
async function readyMessage(config: OpenTicketConfig, guild: Guild): Promise<MessageWithButtons | undefined> {
    if (!config.message) return undefined;

    const message = trimMessageText(config.message);
    const issue = renderedMessageIssue(message, MESSAGE_LABEL);
    if (issue) return { kind: 'fail', error: issue };

    return messageWithButtons(guild, message, config.buttons ?? [], MESSAGE_LABEL);
}

/**
 * Opens a ticket for the subject and hands its channel to later blocks.
 *
 * A thin adapter, and deliberately so: it decides nothing. Numbering, the
 * permission model, whether the type auto-claims, and what "open" means all live
 * in the ticket service, where they are testable without a gateway and reachable
 * by the mod-facing commands too. This block only supplies the subject and
 * carries the result back into the run — and posts the flow's own message, if the node has
 * one, in the ticket channel above the card (`messageWithButtons`, as Post Embed posts).
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
            control: 'ticketTypePicker',
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
        {
            key: 'message',
            label: MESSAGE_LABEL,
            description:
                'Posted in the ticket channel, above the ticket card — words, embeds, buttons. Leave it alone and the card goes in by itself.',
            control: 'message',
            swatches: ['#00A2FF', '#FF2D95', '#7A5CFF', '#FF6B35'],
            buttonsKey: 'buttons',
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
            key: TICKET_VARIABLES.ticketId,
            label: 'Ticket ID',
            description: 'The opened ticket, so a later block can close or post to it.',
        },
        {
            naming: 'fixed',
            key: TICKET_VARIABLES.ticketChannelId,
            label: 'Ticket channel',
            description: 'The channel that was created for the ticket.',
            valueKind: 'channel',
        },
    ],
    requires: ['subject'],
    // `manageChannels` because opening a ticket creates a channel, and may
    // create its category. The most channel-hungry block in the tree, so it is
    // the one that would silently pass when capability checking lands. `attachFiles` for
    // the uploaded pictures the flow's own message may show.
    capabilities: ['sendMessages', 'embedLinks', 'attachFiles', 'manageChannels'],
    /*
     * The ticket it opens is announced as opened, of the type picked here — a fixed key,
     * since the type picker takes no `{{var}}`. Never as claimed: `openerId` is null
     * below, so the service's auto-claim has nobody to claim it for, and even a person's
     * auto-claimed ticket announces only `opened`.
     */
    emits: [
        {
            startedBy: 'ticketChanged',
            carries: { event: { value: 'opened' }, ticketType: { fromField: 'ticketType' } },
        },
    ],
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

        // Before the ticket: a message that cannot post fails the run with nothing made.
        const flowMessage = await readyMessage(config, context.guild);
        if (flowMessage?.kind === 'fail') {
            return { kind: 'fail', error: flowMessage.error };
        }

        const subject = requireSubject(context);
        const ticketResult = await openTicket({
            guildId: context.guild.id,
            type: config.ticketType,
            definition,
            subjectId: subject.id,
            openerId: null,
            title: config.title,
            reason: config.reason || 'Opened automatically by a flow',
            // The subject is already a `GuildMember`, so this costs no fetch.
            // The opener is null — a flow filed this — so there is no opener to name.
            subjectIdentity: ticketIdentityFromMember(subject),
            openerIdentity: null,
        });
        if (!ticketResult.ok) throw ticketResult.error;
        const ticket = ticketResult.value;

        const channelResult = await createTicketChannelForTicket({
            guild: context.guild,
            ticket,
            config: configEntity.config,
            subjectName: subject.user.username,
            openerName: null,
        });
        // The record survives a channel that could not be created, holding
        // `channelId` null. That is the point of the record being the ticket:
        // the alternative — the old model — had nowhere to put a half-made one.
        if (!channelResult.ok) throw channelResult.error;
        const channel = channelResult.value;

        const attached = await attachTicketChannel(ticket.id, channel.id);
        if (!attached.ok) throw attached.error;

        // The flow's message first, so the card — what the ticket is run from — is the
        // newest thing in the channel, and the message is there before the ticket is
        // announced as opened (below), so a Ticket Event flow's post lands under it. A send
        // failing here leaves the half-made ticket a failed card send leaves too: a row and
        // a channel, no state message, no announcement.
        if (flowMessage) {
            const posted = await channel.send(flowMessage.options);
            await recordPostedMessage({ posted, buttons: config.buttons ?? [], context, ticketId: ticket.id });
        }

        const message = await channel.send({
            content: `<@${ticket.subjectId}>`,
            embeds: [buildTicketEmbed(attached.value, definition)],
            components: buildTicketButtons(attached.value),
            allowedMentions: { parse: ['users'] },
        });

        // Recorded so a caller with no interaction can re-render this embed, and
        // recording it is what announces the ticket as opened, now its embed exists. A
        // flow did it, so the bot is who acted, and the run's depth goes with it so a flow
        // it starts sits one link further down. Logged rather than thrown: the row is the
        // ticket and the flow has already done the thing it was asked to do — though no
        // flow listening for "opened" will hear this one.
        const stateMessage = await recordTicketStateMessage(attached.value.id, message.id, {
            actorId: context.guild.client.user.id,
            chainDepth: context.chainDepth,
        });
        if (!stateMessage.ok) {
            console.error('[action.openTicket] Failed to record ticket state message id:', stateMessage.error);
        }

        // Pinning is a convenience now, not load-bearing. Under the old design
        // the pinned message *was* the ticket's only state, so failing to pin
        // put it one unpin away from being unresolvable.
        await message.pin().catch(() => undefined);

        context.setOutput(TICKET_VARIABLES.ticketId, ticket.id);
        context.setOutput(TICKET_VARIABLES.ticketChannelId, channel.id);

        return { kind: 'continue' };
    },
};
