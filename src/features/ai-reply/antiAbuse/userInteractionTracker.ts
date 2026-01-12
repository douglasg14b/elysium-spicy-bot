import { Result, ok, fail } from '../../../shared/resultPattern';

/**
 * Represents a user's interaction history
 */
export interface UserInteractionHistory {
    userId: string;
    guildId: string;
    interactionTimestamps: number[];
    lastInteractedAt: number;
    totalInteractions: number;
}

export class UserInteractionTracker {
    private userHistories = new Map<string, UserInteractionHistory>();

    recordUserInteraction(userId: string, guildId: string): Result<UserInteractionHistory> {
        try {
            const key = this.getUserHistoryKey(userId, guildId);
            const now = Date.now();

            let history = this.userHistories.get(key);
            if (!history) {
                history = {
                    userId,
                    guildId,
                    interactionTimestamps: [],
                    lastInteractedAt: now,
                    totalInteractions: 0,
                };
            }

            // Add new timestamp
            history.interactionTimestamps.push(now);
            history.lastInteractedAt = now;
            history.totalInteractions++;

            // Clean old timestamps (keep only last 24 hours for rate limiting)
            const oneDayAgo = now - 24 * 60 * 60 * 1000;
            history.interactionTimestamps = history.interactionTimestamps.filter((timestamp) => timestamp > oneDayAgo);

            this.userHistories.set(key, history);
            return ok(history);
        } catch (error) {
            return fail(error instanceof Error ? error : new Error(String(error)));
        }
    }

    getUserHistory(userId: string, guildId: string): UserInteractionHistory | null {
        const key = this.getUserHistoryKey(userId, guildId);
        return this.userHistories.get(key) || null;
    }

    /**
     * Clean up old data to prevent memory leaks
     */
    cleanup(olderThanHours = 24): void {
        const cutoff = Date.now() - olderThanHours * 60 * 60 * 1000;

        // Clean old timestamps from user histories
        for (const [key, history] of this.userHistories.entries()) {
            history.interactionTimestamps = history.interactionTimestamps.filter((timestamp) => timestamp > cutoff);
            if (history.interactionTimestamps.length === 0 && history.lastInteractedAt < cutoff) {
                this.userHistories.delete(key);
            }
        }
    }

    /**
     * Generate a unique key for user history
     */
    private getUserHistoryKey(userId: string, guildId: string): string {
        return `${guildId}:${userId}`;
    }
}

export const userInteractionTracker = new UserInteractionTracker();
