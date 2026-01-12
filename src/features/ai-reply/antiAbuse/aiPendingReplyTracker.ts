import { Result, ok, fail } from '../../../shared/resultPattern';

/**
 * Represents a pending AI reply for a user in a channel
 */
export interface PendingReply {
    userId: string;
    channelId: string;
    guildId: string;
    timestamp: number;
    messageId?: string; // ID of the message being replied to
}

export class AiPendingReplyTracker {
    private pendingReplies = new Map<string, PendingReply>();

    private getPendingReplyKey(userId: string, channelId: string): string {
        return `${userId}:${channelId}`;
    }

    addPendingReply(userId: string, channelId: string, guildId: string, messageId?: string): Result<void> {
        try {
            if (this.hasPendingReply(userId, channelId)) {
                console.warn(`User ${userId} already has a pending reply in channel ${channelId}`);
                return fail('User already has a pending reply in this channel');
            }

            const key = this.getPendingReplyKey(userId, channelId);

            const pendingReply: PendingReply = {
                userId,
                channelId,
                guildId,
                timestamp: Date.now(),
                messageId,
            };

            this.pendingReplies.set(key, pendingReply);
            return ok();
        } catch (error) {
            console.error('Error adding pending reply:', error);
            return fail(error instanceof Error ? error : new Error(String(error)));
        }
    }

    removePendingReply(userId: string, channelId: string): Result<void> {
        try {
            console.log(`Removing pending reply for user ${userId} in channel ${channelId}`);
            const key = this.getPendingReplyKey(userId, channelId);
            const removed = this.pendingReplies.delete(key);

            if (!removed) {
                return fail('No pending reply found for this user in this channel');
            }

            return ok();
        } catch (error) {
            return fail(error instanceof Error ? error : new Error(String(error)));
        }
    }

    hasPendingReply(userId: string, channelId: string): boolean {
        const key = this.getPendingReplyKey(userId, channelId);
        return this.pendingReplies.has(key);
    }

    getUserPendingReplies(userId: string): PendingReply[] {
        return Array.from(this.pendingReplies.values()).filter((reply) => reply.userId === userId);
    }

    /**
     * Clean up old data to prevent memory leaks
     */
    cleanup(olderThanHours = 24): void {
        const cutoff = Date.now() - olderThanHours * 60 * 60 * 1000;

        // Clean old pending replies
        for (const [key, reply] of this.pendingReplies.entries()) {
            if (reply.timestamp < cutoff) {
                this.pendingReplies.delete(key);
            }
        }
    }
}

// Create and export a singleton instance
export const aiPendingReplyTracker = new AiPendingReplyTracker();
