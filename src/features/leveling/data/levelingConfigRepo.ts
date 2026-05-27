import { database } from '../../../features-system/data-persistence/database';
import {
    DEFAULT_MESSAGE_COOLDOWN_MS,
    DEFAULT_MESSAGE_XP_MAX,
    DEFAULT_MESSAGE_XP_MIN,
    DEFAULT_PHOTO_XP_BONUS_ENABLED,
    DEFAULT_REACTION_XP_ENABLED,
    DEFAULT_PHOTO_XP_BONUS_MAX,
    DEFAULT_PHOTO_XP_BONUS_MIN,
    DEFAULT_REACTION_COOLDOWN_MS,
    DEFAULT_REACTION_XP_MAX,
    DEFAULT_REACTION_XP_MIN,
    LEVELING_CONFIG_VERSION,
} from '../constants';
import { LevelingConfig } from './levelingConfigSchema';
import { applyLevelingCodeDefaults } from '../logic/levelingConfigDefaults';

export type LevelingGuildConfigInput = {
    guildId: string;
    enabled: boolean;
    notificationChannelId?: string;
};

export class LevelingConfigRepo {
    async getByGuildId(guildId: string): Promise<LevelingConfig | null> {
        const config = await database
            .selectFrom('leveling_config')
            .selectAll()
            .where('guildId', '=', guildId)
            .executeTakeFirst();

        return config ? applyLevelingCodeDefaults(config) : null;
    }

    async upsertGuildSettings(input: LevelingGuildConfigInput): Promise<LevelingConfig> {
        const existing = await this.getByGuildId(input.guildId);
        const now = new Date().toISOString();

        if (existing) {
            await database
                .updateTable('leveling_config')
                .set({
                    enabled: input.enabled,
                    notificationChannelId: input.notificationChannelId ?? existing.notificationChannelId,
                    updatedAt: now,
                })
                .where('guildId', '=', input.guildId)
                .execute();
        } else {
            await database
                .insertInto('leveling_config')
                .values({
                    guildId: input.guildId,
                    enabled: input.enabled,
                    notificationChannelId: input.notificationChannelId ?? '',
                    messageXpMin: DEFAULT_MESSAGE_XP_MIN,
                    messageXpMax: DEFAULT_MESSAGE_XP_MAX,
                    messageCooldownMs: DEFAULT_MESSAGE_COOLDOWN_MS,
                    reactionXpMin: DEFAULT_REACTION_XP_MIN,
                    reactionXpMax: DEFAULT_REACTION_XP_MAX,
                    reactionCooldownMs: DEFAULT_REACTION_COOLDOWN_MS,
                    reactionXpEnabled: DEFAULT_REACTION_XP_ENABLED,
                    photoXpBonusMin: DEFAULT_PHOTO_XP_BONUS_MIN,
                    photoXpBonusMax: DEFAULT_PHOTO_XP_BONUS_MAX,
                    photoBonusEnabled: DEFAULT_PHOTO_XP_BONUS_ENABLED,
                    createdAt: now,
                    updatedAt: now,
                    configVersion: LEVELING_CONFIG_VERSION,
                })
                .execute();
        }

        return (await this.getByGuildId(input.guildId)) as LevelingConfig;
    }
}

export const levelingConfigRepo = new LevelingConfigRepo();
