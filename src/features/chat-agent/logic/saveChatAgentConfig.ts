import { ChannelType, type Guild } from 'discord.js';
import { describeRefusedRoles, isAssignableRole } from '../../../utils/isAssignableRole';
import { chatAgentConfigRepo, type ChatAgentConfigRepo } from '../data/chatAgentConfigRepo';
import { duplicateContextChannelId, type ChatAgentConfig } from '../data/chatAgentConfigSchema';
import { introsChannelSaved } from '../intros/introsSync';
import { botCanRead } from '../tools/visibleChannels';

export type SaveChatAgentConfigResult =
    | { readonly ok: true; readonly config: ChatAgentConfig }
    | { readonly ok: false; readonly message: string };

/**
 * Validate-and-persist for a guild's chat agent config, the dashboard PUT's one path. Each
 * context channel, and a newly picked intros channel, must be a text channel of `guild` the bot can read
 * — asked of the guild's channel cache, never of Discord, as `validateWarningsModChannel` does
 * — and each context channel listed once. Staff roles are deduplicated, and each one newly
 * added must be an assignable role of `guild` (`isAssignableRole`); one already saved is left
 * alone even once deleted, as Server Settings' staff roles are, so a role gone from Discord
 * cannot make the page unsaveable. The whole config is refused on the first problem; nothing
 * is stored then. The `message` is user-safe.
 *
 * The list's length and the texts' lengths are the request schema's rules, and the repo's.
 * "Listed once" is checked here for its sentence, and again by the repo as its invariant.
 *
 * A changed intros channel is handed to the intros copy (`introsChannelSaved`), which starts
 * reading the new one — the one place it hears of a change.
 */
export async function saveChatAgentConfig(
    guild: Guild,
    config: ChatAgentConfig,
    repo: ChatAgentConfigRepo = chatAgentConfigRepo
): Promise<SaveChatAgentConfigResult> {
    const duplicate = duplicateContextChannelId(config.contextChannels);
    if (duplicate) {
        return { ok: false, message: `${channelLabel(guild, duplicate)} is on the list twice. Once is plenty.` };
    }

    const previous = await repo.getConfig(guild.id);
    // The intros channel is checked only when it changes, as staff roles are: one deleted in Discord since must not make the page unsaveable.
    const newIntrosChannel = config.introsChannelId && config.introsChannelId !== previous.introsChannelId ? [config.introsChannelId] : [];
    const channelIds = [...config.contextChannels.map(({ channelId }) => channelId), ...newIntrosChannel];
    for (const channelId of channelIds) {
        const problem = readableTextChannelProblem(guild, channelId);
        if (problem) return { ok: false, message: problem };
    }

    const staffRoleIds = [...new Set(config.staffRoleIds)];
    const refused = staffRoleIds.filter((roleId) => !previous.staffRoleIds.includes(roleId) && !isAssignableRole(guild, roleId));
    if (refused.length > 0) return { ok: false, message: describeRefusedRoles(guild, refused, "the chat agent's staff roles") };

    const saved = await repo.saveConfig(guild.id, { ...config, staffRoleIds });
    if (saved.introsChannelId !== previous.introsChannelId) introsChannelSaved(guild, saved.introsChannelId);
    return { ok: true, config: saved };
}

/** Why `channelId` cannot be one of the agent's channels, or undefined when it can. */
function readableTextChannelProblem(guild: Guild, channelId: string): string | undefined {
    const channel = guild.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
        return "That's not a text channel on this server. Pick one from the list.";
    }
    if (!botCanRead(guild, channel)) {
        return `I can't read #${channel.name}. Give me View Channel and Read Message History there first.`;
    }
    return undefined;
}

function channelLabel(guild: Guild, channelId: string): string {
    const name = guild.channels.cache.get(channelId)?.name;
    return name ? `#${name}` : 'That channel';
}
