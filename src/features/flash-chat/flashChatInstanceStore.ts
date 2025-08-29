import { DISCORD_CLIENT } from '../../discordClient';
import { flashChatRepo } from './data/flashChatRepo';
import { FlashChatConfig } from './data/flashChatSchema';
import { FlashChatInstance } from './flashChatInstance';

/** Live instance store for flash chats */
export class FlashChatInstanceStore {
    instances: Map<string, Map<string, FlashChatInstance>> = new Map();

    public async getInstance(guildId: string, channelId: string): Promise<FlashChatInstance | undefined> {
        // First check if we already have the instance in memory
        // If not, and a config exists, create one
        // THis should be an incredibly rare, if not "supposedly impossible" situation, only bugs will cause this
        if (!this.instances.has(guildId) && !this.instances.get(guildId)?.has(channelId)) {
            const existingConfig = await flashChatRepo.get(guildId, channelId);

            if (!existingConfig) {
                throw new Error(`No flash chat config found for guild ${guildId} and channel ${channelId}`);
            }

            console.warn(
                `⚠️ Flash chat instance for guild ${guildId} and channel ${channelId} was missing but config found. Restarting instance.`
            );
            return this.startInstance(existingConfig);
        }

        const instance = this.instances.get(guildId)?.get(channelId);
        return instance;
    }

    public startInstance(config: FlashChatConfig): FlashChatInstance {
        if (this.has(config.guildId, config.channelId)) {
            throw new Error(`Flash chat instance already exists for channel ID ${config.channelId}`);
        }

        if (!this.instances.has(config.guildId)) {
            this.instances.set(config.guildId, new Map());
        }

        const instance = new FlashChatInstance(config, DISCORD_CLIENT);
        this.instances.get(config.guildId)?.set(config.channelId, instance);

        instance.start();

        return instance;
    }

    public stopInstance(guildId: string, channelId: string) {
        const instance = this.instances.get(guildId)?.get(channelId);
        if (!instance) {
            throw new Error(`No flash chat instance found for guild ${guildId} and channel ${channelId}`);
        }

        instance.stop();
        this.instances.delete(channelId);
    }

    public set(guildId: string, channelId: string, instance: FlashChatInstance) {
        if (!this.instances.has(guildId)) {
            this.instances.set(guildId, new Map());
        }

        this.instances.get(guildId)?.set(channelId, instance);
    }

    public has(guildId: string, channelId: string): FlashChatInstance | undefined {
        return this.instances.get(guildId)?.get(channelId);
    }

    public delete(guildId: string, channelId: string) {
        const instance = this.instances.get(guildId)?.get(channelId);
        if (instance) {
            instance.stop();
        }

        this.instances.delete(channelId);
    }
}

export const flashChatInstanceStore = new FlashChatInstanceStore();
