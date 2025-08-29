import { User } from 'discord.js';
import { flashChatInstanceStore } from './flashChatInstanceStore';
import { Fail, Result } from '@eicode/result-pattern';
import { boolToInt, fail, ok } from '../../shared';
import { flashChatRepo } from './data/flashChatRepo';

type FlashChatArgs = {
    guildId: string;
    channelId: string;
    timeoutSeconds: number;
    preservePinned: boolean;
    preserveHistory: boolean;
    user: User;
};

export class FlashChatService {
    async startFlashChat(args: FlashChatArgs) {
        const runningInstance = flashChatInstanceStore.has(args.guildId, args.channelId);
        if (runningInstance) {
            return fail('Flash chat instance already running for this channel');
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

        flashChatInstanceStore.startInstance(config);
        return ok(config);
    }

    async stopFlashChat(guildId: string, channelId: string) {
        const runningInstance = flashChatInstanceStore.has(guildId, channelId);
        if (!runningInstance) {
            return fail('No flash chat instance running for this channel');
        }

        flashChatInstanceStore.stopInstance(guildId, channelId);
        return ok('Flash chat stopped');
    }

    async modifyFlashChat(args: FlashChatArgs) {
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

        if (flashChatInstanceStore.has(args.guildId, args.channelId)) {
            flashChatInstanceStore.stopInstance(args.guildId, args.channelId);
        }

        flashChatInstanceStore.startInstance(config);
        return ok(config);
    }

    async startAll() {
        const configs = await flashChatRepo.getAllEnabled();
        const results = configs.map((config) => {
            if (flashChatInstanceStore.has(config.guildId, config.channelId)) {
                return fail(`Flash chat already running for ${config.guildId}/${config.channelId}`);
            }

            console.log(`🚀 Starting flash chat for ${config.guildId}/${config.channelId}`);
            flashChatInstanceStore.startInstance(config);
            return ok(`Started flash chat for ${config.guildId}/${config.channelId}`);
        });

        // TODO: Their result pattern lib is broken and doesn't have proper module exports that match their TS defs
        // return ResultUtils.combine(results as Result[]);
    }
}

export const flashChatService = new FlashChatService();
