import { ChannelType, type APIEmbed, type Guild, type TextChannel } from 'discord.js';
import { flashChatManager } from './flashChatManager';
import { flashChatRepo, type FlashChatEditor, type FlashChatSettings } from './data/flashChatRepo';
import type { FlashChatConfig } from './data/flashChatSchema';
import { FLASH_CHAT_DISABLED_NOTICE, flashChatEnabledNotice } from './logic/flashChatNotices';

type ConfigureFlashChatArgs = {
    /** Already passed by `checkFlashChatChannel`. */
    readonly channel: TextChannel;
    readonly settings: FlashChatSettings;
    readonly by: FlashChatEditor;
};

/**
 * Each channel's write in progress, so two saves of one channel — two tabs, or a tab and the
 * slash command — or a save and a removal, run one after the other. Interleaved, a removal
 * could stop the instance between a save's read and its start, leaving one deleting with no
 * row behind it that anything could stop. In this process, which is the only one.
 */
const writesInProgress = new Map<string, Promise<void>>();

async function oneAtATimePerChannel<Result>(guildId: string, channelId: string, work: () => Promise<Result>): Promise<Result> {
    const key = `${guildId}:${channelId}`;    const run =(writesInProgress.get(key) ?? Promise.resolve()).then(work);
    const finished = run.then(
        () => undefined,
        () => undefined,
    );
    writesInProgress.set(key, finished);
    try {
        return await run;
    } finally {
        if (writesInProgress.get(key) === finished) writesInProgress.delete(key);
    }
}

function sameSettings(config: FlashChatConfig, settings: FlashChatSettings): boolean {
    return (
        config.timeoutSeconds === settings.timeoutSeconds &&
        config.preservePinned === settings.preservePinned &&
        config.preserveHistory === settings.preserveHistory
    );
}

/**
 * Flash chat's two writes, shared by the slash command and the dashboard: each saves the
 * channel's row, then starts, restarts or stops its running instance to match, then tells
 * the channel when what its members see has changed.
 */
export class FlashChatService {
    /**
     * Turns flash chat on in a channel, or changes its settings there, and answers the row as
     * saved. Members are told when it starts and whenever its timer changes; the pinned and
     * history settings change quietly.
     *
     * A restart clears the pending per-message timers, leaving those messages to the periodic
     * sweep, so a save that changes nothing on a running channel leaves it running. An
     * instance that cannot start (the channel left the cache, or a permission went, since the
     * caller's check) is logged and not thrown: the settings are saved, and the dashboard
     * lists the channel as not running.
     */
    async configure({ channel, settings, by }: ConfigureFlashChatArgs): Promise<FlashChatConfig> {
        const guildId = channel.guild.id;
        return oneAtATimePerChannel(guildId, channel.id, async () => {
            const existing = await flashChatRepo.get(guildId, channel.id);

            if (existing) {
                await flashChatRepo.updateSettings(guildId, channel.id, settings, by);
            } else {
                await flashChatRepo.insert(guildId, channel.id, settings, by);
            }

            const config = await flashChatRepo.get(guildId, channel.id);
            if (!config) {
                throw new Error(`Flash chat config for ${guildId}/${channel.id} was not there right after saving it.`);
            }

            const running = flashChatManager.has(guildId, channel.id);
            if (!(running && existing && sameSettings(existing, settings))) {
                if (running) flashChatManager.stopInstance(guildId, channel.id);
                try {
                    flashChatManager.startInstance(config);
                } catch (error) {
                    console.error(`❌ Flash chat saved but not started for ${guildId}/${channel.id}:`, error);
                }
            }

            if (!existing || existing.timeoutSeconds !== settings.timeoutSeconds) {
                await postNotice(channel, flashChatEnabledNotice(settings));
            }

            return config;
        });
    }

    /**
     * Turns flash chat off in a channel and forgets its settings. Works whether or not its
     * instance is running — one that failed to start still has a row to remove. Answers the
     * removed config, or `null` when the channel had none.
     */
    async remove(guild: Guild, channelId: string): Promise<FlashChatConfig | null> {
        return oneAtATimePerChannel(guild.id, channelId, async () => {
            const existing = await flashChatRepo.get(guild.id, channelId);
            if (!existing) return null;

            // The row first: a failed delete leaves it running and listed, never stopped yet listed.
            await flashChatRepo.delete(guild.id, channelId);
            if (flashChatManager.has(guild.id, channelId)) {
                flashChatManager.stopInstance(guild.id, channelId);
            }

            // A channel deleted since has nobody left to tell.
            const channel = guild.channels.cache.get(channelId);
            if (channel?.type === ChannelType.GuildText) {
                await postNotice(channel, FLASH_CHAT_DISABLED_NOTICE);
            }

            return existing;
        });
    }

    async startAll() {
        const configs = await flashChatRepo.getAllEnabled();
        for (const config of configs) {
            if (flashChatManager.has(config.guildId, config.channelId)) {
                const guildLabel = flashChatManager.getGuildLabel(config.guildId);
                console.log(`Flash chat already running for ${guildLabel}/${config.channelId}`);
                continue;
            }

            try {
                const guildLabel = flashChatManager.getGuildLabel(config.guildId);
                console.log(`🚀 Starting flash chat for ${guildLabel}/${config.channelId}`);
                flashChatManager.startInstance(config);
                console.log(`✅ Started flash chat for ${guildLabel}/${config.channelId}`);
            } catch (error) {
                const guildLabel = flashChatManager.getGuildLabel(config.guildId);
                console.error(`❌ Failed to start flash chat for ${guildLabel}/${config.channelId}:`, error);
            }
        }
    }
}

/**
 * The notice is a courtesy to the channel: the change has already taken effect, so a post
 * that fails is logged rather than undoing or failing it.
 */
async function postNotice(channel: TextChannel, notice: APIEmbed): Promise<void> {
    try {
        await channel.send({ embeds: [notice] });
    } catch (error) {
        console.warn(`[flash-chat] could not post a notice in #${channel.name} (${channel.id}):`, error);
    }
}

export const flashChatService = new FlashChatService();
