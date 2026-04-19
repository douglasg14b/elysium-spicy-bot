import { User } from 'discord.js';
import { flashChatManager } from './flashChatManager';
import { boolToInt } from '../../shared';
import { flashChatRepo } from './data/flashChatRepo';

type FlashChatArgs = {
    guildId: string;
    channelId: string;
    timeoutSeconds: number;
    preservePinned: boolean;
    preserveHistory: boolean;
    replaceConfig: boolean;
    user: User;
};

export class FlashChatService {
    async startFlashChat(args: FlashChatArgs) {
        console.log(`Starting flash chat for guild ${args.guildId} and channel ${args.channelId}`);

        const runningInstance = flashChatManager.has(args.guildId, args.channelId);
        if (runningInstance && !args.replaceConfig) {
            console.log(`Flash chat instance already running for guild ${args.guildId} and channel ${args.channelId}`);
            return fail('Flash chat instance already running for this channel');
        }

        if (runningInstance && args.replaceConfig) {
            const modifyResult = await this.modifyFlashChat(args);
            return modifyResult;
        }

        let config = await flashChatRepo.get(args.guildId, args.channelId);
        if (!config) {
            config = await flashChatRepo.upsert({
                guildId: args.guildId,
                channelId: args.channelId,
                timeoutSeconds: args.timeoutSeconds,
                preservePinned: boolToInt(args.preservePinned),
                preserveHistory: boolToInt(args.preserveHistory),
                enabled: boolToInt(true),
                removed: boolToInt(false),
                createdBy: args.user.id,
                createdByName: args.user.username,
                updatedBy: args.user.id,
                updatedByName: args.user.username,
                configVersion: 1,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            });
        }

        flashChatManager.startInstance(config);
        return ok(config);
    }

    async stopFlashChat(guildId: string, channelId: string) {
        const runningInstance = flashChatManager.has(guildId, channelId);
        if (!runningInstance) {
            return fail('No flash chat instance running for this channel');
        }

        const config = runningInstance.config;

        flashChatManager.stopInstance(guildId, channelId);

        flashChatRepo.delete(guildId, channelId);

        return ok('Flash chat stopped');
    }

    async modifyFlashChat(args: FlashChatArgs) {
        console.log(`Modifying flash chat for guild ${args.guildId} and channel ${args.channelId}`);
        const config = await flashChatRepo.upsert({
            guildId: args.guildId,
            channelId: args.channelId,
            timeoutSeconds: args.timeoutSeconds,
            preservePinned: boolToInt(args.preservePinned),
            preserveHistory: boolToInt(args.preserveHistory),
            enabled: boolToInt(true),
            removed: boolToInt(false),
            createdBy: args.user.id,
            createdByName: args.user.username,
            updatedBy: args.user.id,
            updatedByName: args.user.username,
            configVersion: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });

        if (flashChatManager.has(args.guildId, args.channelId)) {
            flashChatManager.stopInstance(args.guildId, args.channelId);
        }

        flashChatManager.startInstance(config);
        return ok(config);
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

export const flashChatService = new FlashChatService();
