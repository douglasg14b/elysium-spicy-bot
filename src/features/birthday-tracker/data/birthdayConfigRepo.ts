import { database } from '../../../features-system/data-persistence/database';
import { BirthdayConfig } from './birthdayConfigSchema';

export class BirthdayConfigRepo {
    async getByGuildId(guildId: string): Promise<BirthdayConfig | null> {
        const config = await database
            .selectFrom('birthday_config')
            .selectAll()
            .where('guildId', '=', guildId)
            .executeTakeFirst();

        return config || null;
    }

    async isConfigured(guildId: string): Promise<boolean> {
        const config = await this.getByGuildId(guildId);
        return !!config?.announcementChannelId;
    }

    async upsertAnnouncementChannel(
        guildId: string,
        announcementChannelId: string,
        contextChannelId?: string | null
    ): Promise<BirthdayConfig> {
        const existing = await this.getByGuildId(guildId);
        const now = new Date().toISOString();

        if (existing) {
            await database
                .updateTable('birthday_config')
                .set({
                    announcementChannelId,
                    contextChannelId: contextChannelId === undefined ? existing.contextChannelId : contextChannelId,
                    updatedAt: now,
                })
                .where('guildId', '=', guildId)
                .execute();
        } else {
            await database
                .insertInto('birthday_config')
                .values({
                    guildId,
                    announcementChannelId,
                    contextChannelId: contextChannelId || null,
                    createdAt: now,
                    updatedAt: now,
                    configVersion: 1,
                })
                .execute();
        }

        return (await this.getByGuildId(guildId)) as BirthdayConfig;
    }
}

export const birthdayConfigRepo = new BirthdayConfigRepo();
