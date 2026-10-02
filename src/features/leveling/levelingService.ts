import type { Client, Guild, VoiceState } from 'discord.js';
import type {
    MessageActivityEvent,
    ReactionActivityEvent,
    RecordedActivityEvent,
} from '../../features-system/activity';
import { levelingConfigRepo } from './data/levelingConfigRepo';
import { levelingProgressRepo } from './data/levelingProgressRepo';
import { levelingVoiceSessionRepo } from './data/levelingVoiceSessionRepo';
import { LevelingConfig } from './data/levelingConfigSchema';
import { isSlashCommandMessage } from './logic/activityFilters';
import { getReactionXpGrant } from './logic/levelingConfigDefaults';
import { calculateMessageXp } from './logic/messageXp';
import { getLevelFromTotalXp, messageHasImageAttachment, rollRandomXp } from './logic/xpCalculator';
import { XpActivityType } from './logic/xpGrant';
import { announceLevelUp } from './levelUpAnnouncer';
import { notifyLevelUp } from './levelUpSubscribers';
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

    /**
     * Award XP for a message or reaction the activity recorder has already written.
     *
     * Registered as the activity subscriber in `initLeveling`; leveling has no gateway
     * listener of its own for either. The grant links back to `event.activityEventId`.
     */
    async handleActivity(event: RecordedActivityEvent): Promise<void> {
        switch (event.kind) {
            case 'message':
                return this.handleMessageActivity(event);
            case 'reaction':
                return this.handleReactionActivity(event);
            default: {
                const unhandled: never = event;
                return unhandled;
            }
        }
    }

    /** The recorder has already excluded DMs, system messages, bots and webhooks. */
    private async handleMessageActivity(event: MessageActivityEvent): Promise<void> {
        const { message } = event;

        // Leveling's own rule: a `/`-prefixed message is activity, but never XP.
        if (isSlashCommandMessage(message)) {
            return;
        }

        const config = await levelingConfigRepo.getByGuildId(event.guild.id);
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
            guild: event.guild,
            guildId: event.guild.id,
            userId: event.userId,
            config,
            activityType: 'message',
            xpAmount,
            incrementMessageCount: true,
            incrementPhotoUploadCount,
            messageLength: message.content.length,
            photoBonusApplied: incrementPhotoUploadCount,
            activityEventId: event.activityEventId,
        });
    }

    /** The recorder has already resolved the reactor and excluded bots. */
    private async handleReactionActivity(event: ReactionActivityEvent): Promise<void> {
        const config = await levelingConfigRepo.getByGuildId(event.guild.id);
        if (!isActiveConfig(config) || !config.reactionXpEnabled) {
            return;
        }

        const xpAmount = getReactionXpGrant(config);

        await this.processXpGrant({
            guild: event.guild,
            guildId: event.guild.id,
            userId: event.userId,
            config,
            activityType: 'reaction',
            xpAmount,
            incrementReactionCount: true,
            activityEventId: event.activityEventId,
        });
    }

    async handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
        try {
            const guild = newState.guild ?? oldState.guild;
            if (!guild) {
                return;
            }

            const config = await levelingConfigRepo.getByGuildId(guild.id);
            if (!isActiveConfig(config)) {
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
            const allowStartSessions = isActiveConfig(config);
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
        if (!getVoiceXpSettings().voiceXpEnabled) {
            console.info(
                `[leveling] Skipping voice XP grant while rewards are disabled (guild=${ended.guildId} user=${ended.userId} eligibleMs=${ended.eligibleMs})`
            );
            return;
        }

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
        activityEventId?: number;
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
            activityEventId: input.activityEventId,
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

            /*
             * Notified per level crossed, beside the announcement rather than inside it:
             * `announceLevelUp` returns early when the guild has no notification channel
             * or the bot cannot post there, so hooking it would silently gate every
             * subscriber on unrelated Discord configuration.
             *
             * Awaited, so a slow subscriber cannot interleave two levels of the same
             * climb out of order. `notifyLevelUp` swallows its own failures, so this
             * cannot strand a level the member has already been awarded.
             */
            await notifyLevelUp({ guild, userId, level, totalXp });
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
        case 'flow':
            /*
             * No cooldown. A flow grant is an authored decision rather than a
             * rate-limited reward, and `getLastActivityAt` reports no timestamp for it,
             * so no value here would gate anything — zero says that rather than
             * implying a window that does not exist.
             *
             * Unreachable in practice today: this service grants only the three Discord
             * activity kinds, and a flow awards XP through `awardFlowXp` instead. The
             * arm exists because the union is shared with the persisted vocabulary, and
             * a silent fallthrough would be a cooldown of `undefined`.
             */
            return 0;
    }
}
