import { DISCORD_CLIENT } from '../../../discordClient';
import { database } from '../../data-persistence/database';
import { FlashChatConfig, FlashChatConfigUpdate, NewFlashChatConfig } from './flashChatSchema';

export class FlashChatRepo {
    async get(guildId: string, channelId: string): Promise<FlashChatConfig | null> {
        const config = await database
            .selectFrom('flash_chat_config')
            .selectAll()
            .where('guildId', '=', guildId)
            .where('channelId', '=', channelId)
            .where('removed', '=', false)
            .executeTakeFirst();

        return config || null;
    }

    async getAllEnabled(): Promise<FlashChatConfig[]> {
        const configs = await database
            .selectFrom('flash_chat_config')
            .selectAll()
            .where('enabled', '=', true)
            .where('removed', '=', false)
            .execute();

        return configs;
    }

    async upsert(config: NewFlashChatConfig): Promise<FlashChatConfig> {
        const existing = await this.get(config.guildId, config.channelId);

        if (existing) {
            await database
                .updateTable('flash_chat_config')
                .set(config)
                .where('guildId', '=', config.guildId)
                .where('channelId', '=', config.channelId)
                .execute();
        } else {
            await database.insertInto('flash_chat_config').values(config).execute();
        }

        return (await this.get(config.guildId, config.channelId)) as FlashChatConfig;
    }

    async update(config: FlashChatConfigUpdate & { id: string; guildId: string; channelId: string }): Promise<void> {
        const { id, guildId, channelId, ...updateData } = config;
        await database
            .updateTable('flash_chat_config')
            .set(updateData)
            .where('guildId', '=', guildId)
            .where('channelId', '=', channelId)
            .execute();
    }
}

export const flashChatRepo = new FlashChatRepo();
