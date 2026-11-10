import { ChannelType, type Guild } from 'discord.js';
import { chatAgentConfigRepo, type ChatAgentConfigRepo } from '../data/chatAgentConfigRepo';
import { duplicateContextChannelId, type ChatAgentConfig } from '../data/chatAgentConfigSchema';
import { botCanRead } from '../tools/visibleChannels';

export type SaveChatAgentConfigResult =
    | { readonly ok: true; readonly config: ChatAgentConfig }
    | { readonly ok: false; readonly message: string };

/**
 * Validate-and-persist for a guild's chat agent config, the dashboard PUT's one path. Each
 * context channel must be a text channel of `guild` the bot can read — asked of the guild's
 * channel cache, never of Discord, as `validateWarningsModChannel` does — and listed once.
 * The whole config is refused on the first bad channel; nothing is stored then. The
 * `message` is user-safe.
 *
 * The list's length and the texts' lengths are the request schema's rules, and the repo's.
 * "Listed once" is checked here for its sentence, and again by the repo as its invariant.
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

    for (const { channelId } of config.contextChannels) {
        const channel = guild.channels.cache.get(channelId);
        if (!channel || channel.type !== ChannelType.GuildText) {
            return { ok: false, message: "That's not a text channel on this server. Pick one from the list." };
        }
        if (!botCanRead(guild, channel)) {
            return {
                ok: false,
                message: `I can't read #${channel.name}. Give me View Channel and Read Message History there first.`,
            };
        }
    }

    return { ok: true, config: await repo.saveConfig(guild.id, config) };
}

function channelLabel(guild: Guild, channelId: string): string {
    const name = guild.channels.cache.get(channelId)?.name;
    return name ? `#${name}` : 'That channel';
}
