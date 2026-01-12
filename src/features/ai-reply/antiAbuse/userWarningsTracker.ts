import { NodeCache } from '@cacheable/node-cache';

import { Result, ok, fail } from '../../../shared/resultPattern';
import { ExpiringArray } from '../../../utils';

export type WarningReason = 'spam' | 'abuse' | 'pending_reply';

export interface UserWarning {
    userId: string;
    guildId: string;
    channelId: string;

    timestamp: number;
    ttlMs: number;
    reason: WarningReason;

    warningMessage: string;

    details?: string;
}

type UserWarningsCacheConfig = {
    userId: string;
    guildId: string;
};

class UserWarningsCache {
    private userId: string;
    private guildId: string;
    private cache: ExpiringArray<UserWarning>;

    constructor(config: UserWarningsCacheConfig) {
        this.userId = config.userId;
        this.guildId = config.guildId;

        this.cache = new ExpiringArray<UserWarning>({ ttlMs: 1000 * 60 * 60 * 24 }); // Default TTL 24 hours
    }

    public add(warning: UserWarning): void {
        this.cache.add(warning, warning.ttlMs);
    }

    public get(reason?: WarningReason): UserWarning[] {
        const allWarnings = this.cache.values();

        if (!reason) {
            return allWarnings;
        }

        return allWarnings.filter((warning) => warning.reason === reason);
    }
}

type AddUserWarningParams = {
    userId: string;
    guildId: string;
    channelId: string;

    ttlMs: number;
    reason: WarningReason;
    warningMessage: string;

    details?: string;
};

/**
 * In-memory service to track AI reply interactions and user behavior
 * This service is extensible and can track additional metrics as needed
 */
export class UserWarningTracker {
    private userWarnings = new Map<string, UserWarningsCache>();

    private getUserKey(userId: string, guildId: string): string {
        return `${userId}:${guildId}`;
    }

    /**
     * Add a warning for a user
     */
    addUserWarning({
        userId,
        guildId,
        channelId,
        reason,
        ttlMs,
        details,
        warningMessage,
    }: AddUserWarningParams): Result<UserWarning> {
        try {
            console.log(`Adding warning for user ${userId} for reason: ${reason}`);
            const key = this.getUserKey(userId, guildId);
            const warning: UserWarning = {
                userId,
                guildId,
                channelId,
                timestamp: Date.now(),
                reason,
                warningMessage,
                ttlMs,
                details,
            };

            let warnings = this.userWarnings.get(key) || new UserWarningsCache({ userId, guildId });
            warnings.add(warning);

            this.userWarnings.set(key, warnings);

            return ok(warning);
        } catch (error) {
            return fail(error instanceof Error ? error : new Error(String(error)));
        }
    }

    /**
     * Get user's warning history
     */
    getUserWarnings(userId: string, guildId: string, reason?: UserWarning['reason']): UserWarning[] {
        const key = this.getUserKey(userId, guildId);
        const warnings = this.userWarnings.get(key);

        if (!warnings) return [];

        return warnings.get(reason);
    }

    getRecentUserWarnings(userId: string, guildId: string, withinMinutes: number): UserWarning[] {
        const warningsArray = this.getUserWarnings(userId, guildId);

        const cutoff = Date.now() - withinMinutes * 60 * 1000;
        return warningsArray.filter((warning) => warning.timestamp > cutoff);
    }
}

export const userWarningsTracker = new UserWarningTracker();
