import { database } from '../../../features-system/data-persistence/database';
import { BirthdayConfigRow } from './birthdayConfigSchema';

export class BirthdayConfigRepository {
    async getByGuildId(guildId: string): Promise<BirthdayConfigRow | null> {
        const row = await database
            .selectFrom('birthday_config')
            .selectAll()
            .where('guildId', '=', guildId)
            .executeTakeFirst();
        return row ?? null;
    }

    async upsertAnnouncementChannel(guildId: string, announcementChannelId: string): Promise<BirthdayConfigRow> {
        const existing = await this.getByGuildId(guildId);
        const now = new Date().toISOString();

        if (existing) {
            await database
                .updateTable('birthday_config')
                .set({
                    announcementChannelId,
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
                    createdAt: now,
                    updatedAt: now,
                    configVersion: 1,
                })
                .execute();
        }

        return (await this.getByGuildId(guildId)) as BirthdayConfigRow;
    }

    async isConfigured(guildId: string): Promise<boolean> {
        const row = await this.getByGuildId(guildId);
        return !!row?.announcementChannelId;
    }
}

export const birthdayConfigRepository = new BirthdayConfigRepository();
