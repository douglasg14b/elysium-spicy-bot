import type {
    Client,
    Guild,
    Message,
    MessageReaction,
    PartialMessageReaction,
    PartialUser,
    User,
} from 'discord.js';
import { levelingConfigRepo } from './data/levelingConfigRepo';
import { levelingProgressRepo } from './data/levelingProgressRepo';
import { LevelingConfig } from './data/levelingConfigSchema';
import { shouldSkipMessageForXp, shouldSkipReactionUser } from './logic/activityFilters';
import { getReactionXpGrant } from './logic/levelingConfigDefaults';
import { calculateMessageXp } from './logic/messageXp';
import { getLevelFromTotalXp, messageHasImageAttachment, rollRandomXp } from './logic/xpCalculator';
import { XpActivityType } from './logic/xpGrant';
import { announceLevelUp } from './levelUpAnnouncer';

export class LevelingService {
    constructor(private readonly client: Client) {}

    async handleMessageCreate(message: Message): Promise<void> {
        if (shouldSkipMessageForXp(message)) {
            return;
        }

        const config = await levelingConfigRepo.getByGuildId(message.guildId!);
        if (!isActiveConfig(config)) {
            return;
        }

        let xpAmount = calculateMessageXp(message.content, config.messageXpMin, config.messageXpMax);
        let incrementPhotoUploadCount = false;

        if (config.photoBonusEnabled && messageHasImageAttachment([...message.attachments.values()])) {
            xpAmount += rollRandomXp(config.photoXpBonusMin, config.photoXpBonusMax);
            incrementPhotoUploadCount = true;
        }

        if (xpAmount <= 0) {
            return;
        }

        await this.processXpGrant({
            guild: message.guild!,
            guildId: message.guildId!,
            userId: message.author.id,
            config,
            activityType: 'message',
            xpAmount,
            incrementMessageCount: true,
            incrementPhotoUploadCount,
            messageLength: message.content.length,
            photoBonusApplied: incrementPhotoUploadCount,
        });
    }

    async handleReactionAdd(
        reaction: MessageReaction | PartialMessageReaction,
        user: User | PartialUser
    ): Promise<void> {
        const resolvedUser = await resolveReactionUser(user);
        if (!resolvedUser || shouldSkipReactionUser(resolvedUser)) {
            return;
        }

        const message = await resolveReactionMessage(reaction);
        if (!message?.guildId || !message.guild) {
            return;
        }

        const config = await levelingConfigRepo.getByGuildId(message.guildId);
        if (!isActiveConfig(config) || !config.reactionXpEnabled) {
            return;
        }

        const xpAmount = getReactionXpGrant(config);

        await this.processXpGrant({
            guild: message.guild,
            guildId: message.guildId,
            userId: resolvedUser.id,
            config,
            activityType: 'reaction',
            xpAmount,
            incrementReactionCount: true,
        });
    }

    private async processXpGrant(input: {
        guild: Guild;
        guildId: string;
        userId: string;
        config: LevelingConfig;
        activityType: XpActivityType;
        xpAmount: number;
        incrementMessageCount?: boolean;
        incrementReactionCount?: boolean;
        incrementPhotoUploadCount?: boolean;
        messageLength?: number | null;
        photoBonusApplied?: boolean;
    }): Promise<void> {
        const cooldownMs =
            input.activityType === 'message' ? input.config.messageCooldownMs : input.config.reactionCooldownMs;
        const grantedAt = new Date();

        const grantResult = await levelingProgressRepo.grantXp({
            guildId: input.guildId,
            userId: input.userId,
            xpAmount: input.xpAmount,
            activityType: input.activityType,
            cooldownMs,
            grantedAt,
            incrementMessageCount: input.incrementMessageCount,
            incrementReactionCount: input.incrementReactionCount,
            incrementPhotoUploadCount: input.incrementPhotoUploadCount,
            messageLength: input.messageLength,
            photoBonusApplied: input.photoBonusApplied,
        });

        if (!grantResult) {
            return;
        }

        const previousLevel = getLevelFromTotalXp(grantResult.previousTotalXp);
        const newLevel = getLevelFromTotalXp(grantResult.newTotalXp);

        await this.handleLevelUps(
            input.guild,
            input.config,
            input.userId,
            previousLevel,
            newLevel,
            grantResult.newTotalXp
        );
    }

    private async handleLevelUps(
        guild: Guild,
        config: LevelingConfig,
        userId: string,
        previousLevel: number,
        newLevel: number,
        totalXp: number
    ): Promise<void> {
        if (newLevel <= previousLevel) {
            return;
        }

        for (let level = previousLevel + 1; level <= newLevel; level++) {
            await announceLevelUp({
                client: this.client,
                guild,
                config,
                userId,
                level,
                totalXp,
            });
        }
    }
}

function isActiveConfig(config: LevelingConfig | null): config is LevelingConfig {
    return !!config?.enabled;
}

async function resolveReactionUser(user: User | PartialUser): Promise<User | null> {
    if (!user.partial) {
        return user;
    }

    try {
        return await user.fetch();
    } catch (error) {
        console.warn('[leveling] Failed to fetch partial reaction user:', error);
        return null;
    }
}

async function resolveReactionMessage(
    reaction: MessageReaction | PartialMessageReaction
): Promise<Message | null> {
    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (error) {
            console.warn('[leveling] Failed to fetch partial reaction:', error);
            return null;
        }
    }

    const message = reaction.message;
    if (!message.partial) {
        return message;
    }

    try {
        return await message.fetch();
    } catch (error) {
        console.warn('[leveling] Failed to fetch partial reaction message:', error);
        return null;
    }
}
