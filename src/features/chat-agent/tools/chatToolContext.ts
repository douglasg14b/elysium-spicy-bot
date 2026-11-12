import { ChannelType, type Guild, type GuildMember, type GuildTextBasedChannel } from 'discord.js';
import { getTicketByChannel, type TicketEntity } from '../../tickets';
import { guildSettingsRepo } from '../../../features-system/guild-settings';
import { chatAgentConfigRepo } from '../data/chatAgentConfigRepo';
import type { ContextChannel } from '../data/chatAgentConfigSchema';
import { everyoneCanReadHistory, viewersOf, type Viewers } from './visibleChannels';

/**
 * Everything a tool may act within for one turn, and what the turn's instructions need (the admins' rules and notes). Tools close over it rather than taking
 * any of it from the model, so the model can only ask about this server, and only what
 * everyone who will read the answer could see.
 */
export type ChatToolContext = {
    readonly guild: Guild;
    /** Where the conversation is happening. */
    readonly channel: GuildTextBasedChannel;
    /** Who spoke to the bot. */
    readonly asker: GuildMember;
    /** The asker and everyone else who can see `channel`: every channel-revealing tool sees only what all of them can. */
    readonly viewers: Viewers;
    /** Whether every viewer may read this channel's history; when not, the agent reads none of it for them. */
    readonly viewersCanReadHistory: boolean;
    /** The ticket this channel is, or null when it is not one (or the ticket is deleted). */
    readonly ticket: TicketEntity | null;
    /** The server's configured context channels, as saved — unchecked against the asker; every read is. */
    readonly contextChannels: readonly ContextChannel[];
    /** The admins' facts about the server, for the instructions; empty when none. */
    readonly serverNotes: string;
    /** The admins' rules for the agent on this server, for the instructions; empty when none. */
    readonly botRules: string;
    /**
     * Who is staff to the agent: with the owner and Administrators, who may ask its staff-only
     * questions (`staffAccess.ts`). The chat agent's own staff roles when it has any, else
     * Server Settings' — {@link agentStaffRoleIds}.
     */
    readonly staffRoleIds: readonly string[];
    /** The server's intros channel (`getMemberIntro`), as saved — unchecked against the asker; the read is. Null when none. */
    readonly introsChannelId: string | null;
};

/**
 * The roles that make someone staff to the chat agent: its own list when the server has set
 * one, else Server Settings' staff roles. Its own list exists so moderators can be staff to
 * the agent without being staff on the dashboard; a server that never set one keeps the agent
 * on Server Settings'.
 */
export function agentStaffRoleIds(chatAgentStaffRoleIds: readonly string[], serverStaffRoleIds: readonly string[]): readonly string[] {
    return chatAgentStaffRoleIds.length > 0 ? chatAgentStaffRoleIds : serverStaffRoleIds;
}

/** The ticket `channelId` is, unless it is deleted; null when it is not a ticket. */
export async function findLiveTicket(channelId: string): Promise<TicketEntity | null> {
    const ticket = await getTicketByChannel(channelId);
    return ticket && ticket.status !== 'deleted' ? ticket : null;
}

/**
 * The context for a turn in `channel` asked by `asker`. The one place these facts are
 * derived; the server's chat agent config and staff roles are read here, once per turn.
 */
export async function buildChatToolContext(
    channel: GuildTextBasedChannel,
    asker: GuildMember,
    ticket: TicketEntity | null
): Promise<ChatToolContext> {
    // Who is in a private thread is known only once asked: discord.js caches its members from
    // events alone, so after a restart a member of it would be no viewer at all.
    if (channel.type === ChannelType.PrivateThread) await channel.members.fetch();
    const viewers = viewersOf(channel, asker);
    const [config, serverStaffRoleIds] = await Promise.all([
        chatAgentConfigRepo.getConfig(channel.guild.id),
        guildSettingsRepo.getStaffRoleIds(channel.guild.id),
    ]);
    return {
        guild: channel.guild,
        channel,
        asker,
        viewers,
        viewersCanReadHistory: everyoneCanReadHistory(viewers, channel),
        ticket,
        contextChannels: config.contextChannels,
        serverNotes: config.serverNotes,
        botRules: config.botRules,
        staffRoleIds: agentStaffRoleIds(config.staffRoleIds, serverStaffRoleIds),
        introsChannelId: config.introsChannelId,
    };
}
