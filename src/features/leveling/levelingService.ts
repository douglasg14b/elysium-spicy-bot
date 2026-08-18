import type {
    Client,
    Guild,
    Message,
    MessageReaction,
    PartialMessageReaction,
    PartialUser,
    User,
    VoiceState,
} from 'discord.js';
import { levelingConfigRepo } from './data/levelingConfigRepo';
import { levelingProgressRepo } from './data/levelingProgressRepo';
import { levelingVoiceSessionRepo } from './data/levelingVoiceSessionRepo';
import { LevelingConfig } from './data/levelingConfigSchema';
import { shouldSkipMessageForXp, shouldSkipReactionUser } from './logic/activityFilters';
import { getReactionXpGrant } from './logic/levelingConfigDefaults';
import { calculateMessageXp } from './logic/messageXp';
import { getLevelFromTotalXp, messageHasImageAttachment, rollRandomXp } from './logic/xpCalculator';
import { XpActivityType } from './logic/xpGrant';
import { announceLevelUp } from './levelUpAnnouncer';
import {
    createVoiceSessionCoordinator,
    VoiceSessionCoordinator,
    type EndedVoiceSession,
} from './logic/voiceSessionCoordinator';
import { calculateVoiceXpFromEligibleMs, getVoiceXpSettings, logIsolatedVoiceXpError, VOICE_ELIGIBILITY_RULE } from './logic/voiceXp';

export class LevelingService {
    private readonly voiceSessionCoordinator: VoiceSessionCoordinator;

    constructor(private readonly client: Client, voiceSessionCoordinator?: VoiceSessionCoordinator) {
        try {
            this.voiceSessionCoordinator =
                voiceSessionCoordinator ??
                createVoiceSessionCoordinator({
                    voiceSessionRepo: levelingVoiceSessionRepo,
                    onSessionEnd: (ended) => this.processVoiceSessionEnd(ended),
                });
        } catch (error) {
            logIsolatedVoiceXpError('coordinator setup', error);
            this.voiceSessionCoordinator = {
                handleVoiceStateUpdate: async () => undefined,
                reconcileGuild: async () => undefined,
                applyEvents: async () => undefined,
            } as VoiceSessionCoordinator;
        }
    }

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

    async handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
        try {
            const guild = newState.guild ?? oldState.guild;
            if (!guild) {
                return;
            }

            const config = await levelingConfigRepo.getByGuildId(guild.id);
            if (!isActiveConfig(config) || !getVoiceXpSettings().voiceXpEnabled) {
                return;
            }

            await this.voiceSessionCoordinator.handleVoiceStateUpdate(oldState, newState);
        } catch (error) {
            logIsolatedVoiceXpError('voice state update', error);
        }
    }

    async reconcileGuild(guild: Guild, now: Date = new Date()): Promise<void> {
        try {
            const config = await levelingConfigRepo.getByGuildId(guild.id);
            const allowStartSessions = isActiveConfig(config) && getVoiceXpSettings().voiceXpEnabled;
            await this.voiceSessionCoordinator.reconcileGuild(guild, {
                allowStartSessions,
                now,
            });
        } catch (error) {
            logIsolatedVoiceXpError(`reconcile for guild ${guild.id}`, error);
        }
    }

    async reconcileAllGuilds(client: Client = this.client): Promise<void> {
        for (const guild of client.guilds.cache.values()) {
            try {
                await this.reconcileGuild(guild);
            } catch (error) {
                logIsolatedVoiceXpError(`reconcile for guild ${guild.id}`, error);
            }
        }
    }

    async processVoiceSessionEnd(ended: EndedVoiceSession): Promise<void> {
        const config = await levelingConfigRepo.getByGuildId(ended.guildId);
        const { xpAmount, eligibleSeconds } = calculateVoiceXpFromEligibleMs(ended.eligibleMs);
        const grantedAt = ended.endedAt;

        const grantResult = await levelingProgressRepo.grantXp({
            guildId: ended.guildId,
            userId: ended.userId,
            xpAmount,
            activityType: 'voice',
            cooldownMs: getVoiceXpSettings().voiceCooldownMs,
            grantedAt,
            incrementVoiceSessionCount: true,
            addVoiceSeconds: xpAmount > 0 ? eligibleSeconds : 0,
            voiceEligibleSeconds: eligibleSeconds,
            voiceSessionStartedAt: ended.sessionStartedAt,
            voiceSessionEndedAt: ended.endedAt,
            voiceChannelId: ended.channelId,
            voiceEligibilityRule: VOICE_ELIGIBILITY_RULE,
        });

        if (!grantResult) {
            return;
        }

        const guild = await this.resolveGuild(ended.guildId);
        if (!guild || !isActiveConfig(config)) {
            return;
        }

        const previousLevel = getLevelFromTotalXp(grantResult.previousTotalXp);
        const newLevel = getLevelFromTotalXp(grantResult.newTotalXp);

        await this.handleLevelUps(
            guild,
            config,
            ended.userId,
            previousLevel,
            newLevel,
            grantResult.newTotalXp
        );
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
        incrementVoiceSessionCount?: boolean;
        addVoiceSeconds?: number;
        messageLength?: number | null;
        photoBonusApplied?: boolean;
        voiceEligibleSeconds?: number | null;
        voiceSessionStartedAt?: Date | null;
        voiceSessionEndedAt?: Date | null;
        voiceChannelId?: string | null;
        voiceEligibilityRule?: string | null;
    }): Promise<void> {
        const cooldownMs = getCooldownMs(input.activityType, input.config);
        const grantedAt = input.voiceSessionEndedAt ?? new Date();

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
            incrementVoiceSessionCount: input.incrementVoiceSessionCount,
            addVoiceSeconds: input.addVoiceSeconds,
            messageLength: input.messageLength,
            photoBonusApplied: input.photoBonusApplied,
            voiceEligibleSeconds: input.voiceEligibleSeconds,
            voiceSessionStartedAt: input.voiceSessionStartedAt,
            voiceSessionEndedAt: input.voiceSessionEndedAt,
            voiceChannelId: input.voiceChannelId,
            voiceEligibilityRule: input.voiceEligibilityRule,
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

    private async resolveGuild(guildId: string): Promise<Guild | null> {
        const cached = this.client.guilds.cache.get(guildId);
        if (cached) {
            return cached;
        }

        try {
            return await this.client.guilds.fetch(guildId);
        } catch (error) {
            console.warn(`[leveling] Failed to fetch guild ${guildId} for voice XP grant:`, error);
            return null;
        }
    }
}

function isActiveConfig(config: LevelingConfig | null): config is LevelingConfig {
    return !!config?.enabled;
}

function getCooldownMs(activityType: XpActivityType, config: LevelingConfig): number {
    switch (activityType) {
        case 'message':
            return config.messageCooldownMs;
        case 'reaction':
            return config.reactionCooldownMs;
        case 'voice':
            return getVoiceXpSettings().voiceCooldownMs;
    }
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
