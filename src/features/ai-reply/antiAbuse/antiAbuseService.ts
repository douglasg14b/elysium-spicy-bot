import { aiPendingReplyTracker, AiPendingReplyTracker } from './aiPendingReplyTracker';
import { userInteractionTracker, UserInteractionTracker } from './userInteractionTracker';
import { UserWarning, userWarningsTracker, WarningReason } from './userWarningsTracker';

type WarningsConfig = {
    /** Number of warnings before triggering cooldown */
    threshold: number;

    /** Time to live for each warning in milliseconds */
    ttlMs: number;

    cooldown: {
        /** Duration of cooldown in milliseconds after threshold is reached */
        durationMs: number;
        /** Message sent to users when they are on cooldown */
        privateMessage: string;
    };

    /** Custom warning messages to send to users. The last message is the most severe and indicates the user will be ignored */
    warningMessages: string[];
    // rules:
};

export type WarningsConfigs = Record<WarningReason, WarningsConfig>;
export type LimitsConfigs = Record<string, unknown>;

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const DEFAULT_ANTI_ABUSE_CONFIG: WarningsConfigs = {
    pending_reply: {
        threshold: 3,
        ttlMs: 10 * MINUTE, // 10 minutes
        warningMessages: [
            `Hold on! I'm still thinking about your last message. Don't rush me! 😤`,
            `Seriously, stop spamming me! Wait for me to finish or I'll ignore you! 😤`,
            `You did it, I'm no longer responding to you. Enjoy the silence! 😤`,
        ],
        cooldown: {
            durationMs: 5 * MINUTE, // 5 minutes
            privateMessage: `I'm not responding to you right now for ignoring my warnings and continuing to reply while I was still thinking. 😤`,
        },
    },
    spam: {
        threshold: 3,
        ttlMs: 10 * MINUTE, // 10 minutes
        warningMessages: [
            `Whoa there! You're sending messages too quickly. Please slow down a bit. 🐢`,
            `I warned you! You're still sending messages too fast. One more time and I won't respond anymore. 🚫`,
            `That's it! You've been sending messages too quickly. I'm ignoring you now. ❌`,
        ],
        cooldown: {
            durationMs: 5 * MINUTE, // 5 minutes
            privateMessage: `I'm not responding to you right now for ignoring my warnings and spamming me. 😤`,
        },
    },
    abuse: {
        threshold: 2,
        ttlMs: 6 * HOUR, // 6 hours
        warningMessages: [
            `This is your first warning for abusive language. Please be respectful or I won't respond anymore. ⚠️`,
            `You've used abusive language again. I'm ignoring you now. ❌`,
        ],
        cooldown: {
            durationMs: 30 * MINUTE, // 30 minutes
            privateMessage: `I'm not responding to you right now for ignoring my warnings and using abusive language. 😤`,
        },
    },
};

const LIMITS_CONFIG = {
    spam: {
        maxInteractionsPerMinute: 4,
    },
};

type CommonPredicateParams = {
    userId: string;
    guildId: string;
    channelId: string;
    interactionsTracker: UserInteractionTracker;
    pendingReplyTracker: AiPendingReplyTracker;
};

const shouldWarnPredicates: Array<[WarningReason, (params: CommonPredicateParams) => boolean]> = [
    [
        'pending_reply',
        (params: CommonPredicateParams) => {
            const { userId, guildId, channelId, pendingReplyTracker } = params;

            return pendingReplyTracker.hasPendingReply(userId, channelId);
        },
    ],
    [
        'spam',
        (params: CommonPredicateParams) => {
            const { userId, guildId, interactionsTracker } = params;
            const config = LIMITS_CONFIG.spam;
            const history = interactionsTracker.getUserHistory(userId, guildId);
            if (!history) return false;

            // limit to n interactions in the last minute
            const oneMinuteAgo = Date.now() - MINUTE;
            const recentInteractions = history.interactionTimestamps.filter((ts) => ts > oneMinuteAgo);
            if (recentInteractions.length > config.maxInteractionsPerMinute) {
                return true;
            }

            // Limit to n interactions per minute on average for the last 5 minutes
            const fiveMinutesAgo = Date.now() - 5 * MINUTE;
            const interactionsInLastFiveMinutes = history.interactionTimestamps.filter((ts) => ts > fiveMinutesAgo);
            const averagePerMinute = interactionsInLastFiveMinutes.length / 5;
            return averagePerMinute > config.maxInteractionsPerMinute;
        },
    ],
    [
        'abuse',
        (_params: CommonPredicateParams) => {
            // Currently no automatic predicate for abuse warnings
            return false;
        },
    ],
];

type UserCooldown = {
    userId: string;
    guildId: string;
    expiresAt: number;
    reason: WarningReason;
    message: string;
};

export type ProcessInteractionAttemptParams = {
    userId: string;
    guildId: string;
    channelId: string;
};

export type ProcessInteractionAttemptResultBase = {
    /** Interaction is allowed */
    allowed: boolean;

    /** Was a warning issued for this interaction */
    warningIssued: boolean;

    /** Was a cooldown issued for this interaction */
    cooldownIssued: boolean;

    /** Existing or issues Cooldown */
    cooldown: UserCooldown | null;

    /** Issued Warning, if one was issues */
    warning: UserWarning | null;

    message: string;
};

type ProcessInteractionAttemptAllowedResult = ProcessInteractionAttemptResultBase & {
    allowed: true;
    warningIssued: false;
    cooldownIssued: false;
    cooldown: null;
    warning: null;
};

type ProcessInteractionAttemptDeniedResult = ProcessInteractionAttemptResultBase & {
    allowed: false;
    warningIssued: boolean;
    cooldownIssued: boolean;
    cooldown: UserCooldown | null;
    warning: UserWarning | null;
    message: string;
};

type ProcessInteractionAttemptResult =
    | ProcessInteractionAttemptAllowedResult
    | ProcessInteractionAttemptDeniedResult
    | ProcessInteractionAttemptResultBase;

export class AntiAbuseService {
    private config: WarningsConfigs;
    private cooldownUsers = new Map<string, UserCooldown>();

    constructor(config: WarningsConfigs) {
        this.config = config;
    }

    isUserOnCooldown(userId: string, guildId: string): false | UserCooldown {
        const cooldownKey = `${userId}:${guildId}`;
        const existingCooldown = this.cooldownUsers.get(cooldownKey);
        const now = Date.now();

        if (existingCooldown && existingCooldown.expiresAt > now) {
            return existingCooldown;
        } else if (existingCooldown) {
            // Cooldown has expired, remove it
            this.cooldownUsers.delete(cooldownKey);
        }

        return false;
    }

    processInteractionAttempt(params: ProcessInteractionAttemptParams): ProcessInteractionAttemptResult {
        const { userId, guildId, channelId } = params;

        const cooldownKey = `${userId}:${guildId}`;
        const existingCooldown = this.cooldownUsers.get(cooldownKey);
        const now = Date.now();

        // Check if user is currently on cooldown
        if (existingCooldown && existingCooldown.expiresAt > now) {
            return {
                allowed: false,
                warningIssued: false,
                cooldownIssued: false,
                cooldown: existingCooldown,
                warning: null,
                message: this.generateCooldownMessage(existingCooldown),
            };
        } else if (existingCooldown) {
            // Cooldown has expired, remove it
            this.cooldownUsers.delete(cooldownKey);
        }

        const { issuedWarning, issuedCooldown } = this.issueWarningIfNeeded(params);

        if (issuedCooldown) {
            return {
                allowed: false,
                warningIssued: !!issuedWarning,
                cooldownIssued: !!issuedCooldown,
                cooldown: issuedCooldown,
                warning: issuedWarning || null,
                message: this.generateCooldownMessage(issuedCooldown),
            };
        }

        return {
            allowed: !issuedWarning,
            cooldownIssued: false,
            warningIssued: !!issuedWarning,
            cooldown: null,
            warning: issuedWarning || null,
            message: issuedWarning?.warningMessage || '',
        };
    }

    private issueWarningIfNeeded(params: ProcessInteractionAttemptParams) {
        const { userId, guildId, channelId } = params;

        let issuedWarning: UserWarning | null = null;
        let issuedCooldown: UserCooldown | null = null;

        for (const [reason, predicate] of shouldWarnPredicates) {
            const shouldWarn = predicate({
                userId,
                guildId,
                channelId,
                interactionsTracker: userInteractionTracker,
                pendingReplyTracker: aiPendingReplyTracker,
            });

            if (!shouldWarn) continue;

            const warningConfig = this.config[reason];
            const existingWarningCount = userWarningsTracker.getUserWarnings(userId, guildId, reason).length;

            const warningMessage =
                warningConfig.warningMessages[Math.min(existingWarningCount, warningConfig.warningMessages.length - 1)];

            const warningResult = userWarningsTracker.addUserWarning({
                userId,
                guildId,
                channelId,
                reason: reason,
                warningMessage: warningMessage,
                ttlMs: warningConfig.ttlMs,
            });
            if (!warningResult.ok) throw new Error(`Failed to add user warning: ${warningResult.error}`);

            issuedWarning = warningResult.value;

            // Issue cooldown
            if (existingWarningCount >= warningConfig.threshold) {
                const cooldownExpiresAt = Date.now() + warningConfig.cooldown.durationMs;
                const cooldownKey = this.getUserKey(userId, guildId);
                issuedCooldown = {
                    userId,
                    guildId,
                    expiresAt: cooldownExpiresAt,
                    reason: reason,
                    message: warningConfig.cooldown.privateMessage,
                };

                console.log(`Issuing cooldown to user ${userId} for reason ${reason}`);
                this.cooldownUsers.set(cooldownKey, issuedCooldown);
            }
        }

        return {
            issuedWarning,
            issuedCooldown,
        };
    }

    public recordAbuseModerationWarning(userId: string, guildId: string, channelId: string) {
        const reason: WarningReason = 'abuse';
        const warningConfig = this.config[reason];

        const existingWarningCount = userWarningsTracker.getUserWarnings(userId, guildId, reason).length;

        const warningMessage =
            warningConfig.warningMessages[Math.min(existingWarningCount, warningConfig.warningMessages.length - 1)];

        const warningResult = userWarningsTracker.addUserWarning({
            userId,
            guildId,
            channelId,
            reason: reason,
            warningMessage: warningMessage,
            ttlMs: warningConfig.ttlMs,
        });
        if (!warningResult.ok) throw new Error(`Failed to add user warning: ${warningResult.error}`);

        const newWarningsCount = userWarningsTracker.getUserWarnings(userId, guildId, reason).length;
        // Issue cooldown if threshold exceeded
        if (newWarningsCount >= warningConfig.threshold) {
            const cooldownExpiresAt = Date.now() + warningConfig.cooldown.durationMs;
            const cooldownKey = this.getUserKey(userId, guildId);
            const issuedCooldown: UserCooldown = {
                userId,
                guildId,
                expiresAt: cooldownExpiresAt,
                reason: reason,
                message: warningConfig.cooldown.privateMessage,
            };

            console.log(`Issuing cooldown to user ${userId} for reason ${reason}`);
            this.cooldownUsers.set(cooldownKey, issuedCooldown);
        }
    }

    public static generateCooldownTimeRemaining(cooldown: UserCooldown): string {
        const remainingMs = cooldown.expiresAt - Date.now();
        const remainingMinutes = Math.ceil(remainingMs / MINUTE);

        return `${remainingMinutes} minute(s)`;
    }

    public generateCooldownMessage(cooldown: UserCooldown): string {
        const config = this.config[cooldown.reason];

        return config.cooldown.privateMessage;
    }

    private getUserKey(userId: string, guildId: string): string {
        return `${userId}:${guildId}`;
    }
}

export const antiAbuseService = new AntiAbuseService(DEFAULT_ANTI_ABUSE_CONFIG);
