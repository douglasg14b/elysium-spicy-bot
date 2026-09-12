import { database, type DatabaseClient } from '../../../features-system/data-persistence/database';
import { WARNINGS_CONFIG_VERSION } from '../constants';
import type { WarningsConfig } from './warningsConfigSchema';

export class WarningsConfigRepo {
    constructor(private readonly db: DatabaseClient = database) {}

    async getByGuildId(guildId: string): Promise<WarningsConfig | null> {
        const config = await this.db
            .selectFrom('warnings_config')
            .selectAll()
            .where('guildId', '=', guildId)
            .executeTakeFirst();

        return config ?? null;
    }

    async upsertModChannel(guildId: string, modChannelId: string): Promise<WarningsConfig> {
        const existing = await this.getByGuildId(guildId);
        const now = new Date().toISOString();

        if (existing) {
            await this.db
                .updateTable('warnings_config')
                .set({
                    modChannelId,
                    updatedAt: now,
                })
                .where('guildId', '=', guildId)
                .execute();
        } else {
            await this.db
                .insertInto('warnings_config')
                .values({
                    guildId,
                    modChannelId,
                    createdAt: now,
                    updatedAt: now,
                    configVersion: WARNINGS_CONFIG_VERSION,
                })
                .execute();
        }

        const saved = await this.getByGuildId(guildId);
        if (!saved) {
            throw new Error(`Warnings config upsert succeeded but row was not found for guild ${guildId}`);
        }

        return saved;
    }
}

export const warningsConfigRepo = new WarningsConfigRepo();
