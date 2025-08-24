import { DISCORD_CLIENT } from '../../discordClient';
import { FlashChatConfig, FlashChatInstance } from './flashChatInstance';

export class FlashChatRepo {
    instances: Map<string, FlashChatInstance> = new Map();

    public startInstance(config: FlashChatConfig): FlashChatInstance {
        if (this.instances.has(config.channelId)) {
            throw new Error(`Flash chat instance already exists for channel ID ${config.channelId}`);
        }

        const instance = new FlashChatInstance(config, DISCORD_CLIENT);
        this.instances.set(config.channelId, instance);
        instance.start();
        return instance;
    }

    public stopInstance(channelId: string) {
        const instance = this.instances.get(channelId);
        if (!instance) {
            throw new Error(`No flash chat instance found for channel ID ${channelId}`);
        }

        instance.stop();
        this.instances.delete(channelId);
    }

    public set(channelId: string, instance: FlashChatInstance) {
        this.instances.set(channelId, instance);
    }

    public has(channelId: string): FlashChatInstance | undefined {
        return this.instances.get(channelId);
    }

    public delete(channelId: string) {
        const instance = this.instances.get(channelId);
        if (instance) {
            instance.stop();
        }

        this.instances.delete(channelId);
    }
}

export const flashChatRepo = new FlashChatRepo();
