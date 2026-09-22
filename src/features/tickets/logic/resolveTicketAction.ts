import { ChannelType, type ButtonInteraction, type Guild, type GuildMember, type TextChannel } from 'discord.js';
import { fail, ok, type Result } from '../../../shared';
import { ticketingRepo } from '../data/ticketingRepo';
import {
    isTicketingConfigConfigured,
    type ConfiguredTicketingConfig,
    type TicketTypeDefinition,
} from '../data/ticketingSchema';
import type { TicketEntity } from '../data/ticketsSchema';
import { getTicketByChannel } from '../ticketService';
import { memberHasModeratorPerms, memberHasModeratorRole } from './hasModeratorRole';
import { getTicketTypeDefinition } from './ticketTypes';
import { roleIdsToNames } from '../../../utils';

/**
 * Everything a ticket button handler needs, resolved once.
 *
 * The five handlers each opened with the same forty lines: is this a guild, is
 * ticketing configured, does this member have a moderator role, is this a guild
 * text channel, and which ticket is this. Five copies of one sequence is five
 * places for the checks to drift apart — and they already had, in the permission
 * logic those handlers went on to apply.
 */
export interface TicketActionContext {
    readonly guild: Guild;
    readonly member: GuildMember;
    readonly channel: TextChannel;
    readonly config: ConfiguredTicketingConfig;
    readonly ticket: TicketEntity;
    /**
     * The guild's declaration for this ticket's type, non-optional.
     *
     * Resolved here rather than in each handler for the reason this function
     * exists: five handlers each need it, and five copies of "look it up, refuse if
     * absent" is five places for the refusal to drift. Absence is settled once, at
     * the gate, so the render and permission code downstream has no branch to
     * forget.
     */
    readonly definition: TicketTypeDefinition;
}

/**
 * Resolves a button press to the ticket it acts on, or to the reason it cannot.
 *
 * The ticket now comes from the channel id via one indexed query. Previously
 * this meant `findTicketStateMessage`: an in-memory cache, then a pinned-message
 * fetch, then a scan of the last ten messages — so a ticket whose state message
 * had been unpinned, deleted or pushed out of history became permanently
 * unactionable, and its buttons silently dead. A row cannot be pushed out of
 * history.
 *
 * Returns a `Result` carrying user-facing copy rather than throwing, because
 * every failure here is something the member needs told.
 */
export async function resolveTicketAction(
    interaction: ButtonInteraction,
    actionLabel: string
): Promise<Result<TicketActionContext, string>> {
    if (!interaction.guild || !interaction.member) {
        return fail('❌ This can only be used in a server.');
    }

    const guild = interaction.guild;

    const configEntity = await ticketingRepo.get(guild.id);
    if (!isTicketingConfigConfigured(configEntity)) {
        return fail('❌ The ticket system is not configured yet. Please ask an administrator to configure it first.');
    }
    const config = configEntity.config;

    const member = interaction.member as GuildMember;
    if (!memberHasModeratorRole(member, config.moderationRoles) && !memberHasModeratorPerms(member)) {
        const roleNames = await roleIdsToNames(guild, config.moderationRoles);
        return fail(`❌ You need the **${roleNames.join(', ')}** role or moderation permissions to ${actionLabel}.`);
    }

    const channel = interaction.channel;
    if (!channel || channel.type !== ChannelType.GuildText) {
        return fail('❌ This can only be used in a server text channel.');
    }

    const ticket = await getTicketByChannel(channel.id);
    if (!ticket) {
        return fail('❌ This is not a ticket channel.');
    }

    // Named rather than defaulted. A ticket holding a type the guild no longer
    // declares has no permission model and no label to render, and substituting one
    // would re-permission a channel from a guess. Deleting a type is refused while
    // any ticket holds it, so reaching this takes a hand-edited config blob — which
    // is exactly the case that deserves a message rather than a silent fallback.
    const definition = getTicketTypeDefinition(config, ticket.type);
    if (!definition) {
        return fail(
            `❌ Ticket #${ticket.ticketNumber} is typed \`${ticket.type}\`, which this server no longer declares. Re-add that ticket type in the config before touching this one.`
        );
    }

    return ok({ guild, member, channel, config, ticket, definition });
}
