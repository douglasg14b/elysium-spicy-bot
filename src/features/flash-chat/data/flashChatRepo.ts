import { database, type DatabaseClient } from '../../../features-system/data-persistence/database';
import { boolToInt } from '../../../shared';
import type { FlashChatConfig, NewFlashChatConfig } from './flashChatSchema';

/** What an operator chooses for a channel; everything else on the row is bookkeeping. */
export interface FlashChatSettings {
    readonly timeoutSeconds: number;
    readonly preservePinned: boolean;
    readonly preserveHistory: boolean;
}

/** Who saved a change, as stored on the row. */
export interface FlashChatEditor {
    readonly id: string;
    readonly username: string;
}

export class FlashChatRepo {
    constructor(private readonly db: DatabaseClient = database) {}

    async get(guildId: string, channelId: string): Promise<FlashChatConfig | null> {
        const config = await this.db
            .selectFrom('flash_chat_config')
            .selectAll()
            .where('guildId', '=', guildId)
            .where('channelId', '=', channelId)
            .where('removed', '=', false)
            .executeTakeFirst();

        return config || null;
    }

    async getAllEnabled(): Promise<FlashChatConfig[]> {
        const configs = await this.db
            .selectFrom('flash_chat_config')
            .selectAll()
            .where('enabled', '=', true)
            .where('removed', '=', false)
            .execute();

        return configs;
    }

    /** One server's flash chat channels, oldest set-up first. */
    async listByGuild(guildId: string): Promise<FlashChatConfig[]> {
        return this.db
            .selectFrom('flash_chat_config')
            .selectAll()
            .where('guildId', '=', guildId)
            .where('removed', '=', false)
            .orderBy('id')
            .execute();
    }

    /** A channel's first setup. `createdAt` is the floor the periodic cleanup deletes above. */
    async insert(guildId: string, channelId: string, settings: FlashChatSettings, by: FlashChatEditor): Promise<void> {
        const now = new Date().toISOString();
        const row: NewFlashChatConfig = {
            guildId,
            channelId,
            ...settingsColumns(settings),
            enabled: boolToInt(true),
            removed: boolToInt(false),
            createdBy: by.id,
            createdByName: by.username,
            updatedBy: by.id,
            updatedByName: by.username,
            createdAt: now,
            updatedAt: now,
            configVersion: 1,
        };
        await this.db.insertInto('flash_chat_config').values(row).execute();
    }

    /**
     * Changes a channel's settings and nothing else: who set it up, and when, stay as they
     * were. `createdAt` in particular bounds what the periodic cleanup may delete, so an edit
     * that moved it would leave everything posted before the edit undeleted.
     */
    async updateSettings(
        guildId: string,
        channelId: string,
        settings: FlashChatSettings,
        by: FlashChatEditor,
    ): Promise<void> {
        await this.db
            .updateTable('flash_chat_config')
            .set({
                ...settingsColumns(settings),
                // `startAll` boots enabled rows only; a row saved here is one meant to run.
                enabled: boolToInt(true),
                updatedBy: by.id,
                updatedByName: by.username,
                updatedAt: new Date().toISOString(),
            })
            .where('guildId', '=', guildId)
            .where('channelId', '=', channelId)
            .execute();
    }

    async delete(guildId: string, channelId: string): Promise<void> {
        await this.db
            .deleteFrom('flash_chat_config')
            .where('guildId', '=', guildId)
            .where('channelId', '=', channelId)
            .execute();
    }
}

function settingsColumns(
    settings: FlashChatSettings,
): Pick<NewFlashChatConfig, 'timeoutSeconds' | 'preservePinned' | 'preserveHistory'> {
    return {
        timeoutSeconds: settings.timeoutSeconds,
        preservePinned: boolToInt(settings.preservePinned),
        preserveHistory: boolToInt(settings.preserveHistory),
    };
}

export const flashChatRepo = new FlashChatRepo();
