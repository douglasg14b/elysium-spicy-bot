import {
    Client,
    Events,
    FetchMessagesOptions,
    Message,
    OmitPartialGroupDMChannel,
    PartialMessage,
    PermissionsBitField,
    Snowflake,
    TextChannel,
} from 'discord.js';
import { deleteMessageSafely } from './utils';
import { FlashChatConfig } from './data/flashChatSchema';

function getPeriodicCleanupInterval(baseTimeout: number) {
    // Randomize interval between 80% and 120% of base timeout
    const variance = baseTimeout * 0.2;
    return baseTimeout + (Math.random() * variance * 2 - variance);
}

type DeletablePage = {
    messages: Message<true>[];
    next: null | (() => Promise<DeletablePage | null>);
};

export class FlashChatInstance {
    private stopped: boolean = false;
    private _config: FlashChatConfig;
    private client: Client;
    private messageTimers: Map<string, NodeJS.Timeout> = new Map();
    private cleanupTimer: NodeJS.Timeout | null = null;

    constructor(config: FlashChatConfig, client: Client) {
        console.log('channel config:', config);
        this._config = config;
        this.client = client;
    }

    public get channelId() {
        return this._config.channelId;
    }

    public get config() {
        return this._config;
    }

    public handleMessageCreate(message: Message) {
        this.checkStopped();
        if (message.channel.id !== this._config.channelId) return;

        // Skip pinned messages
        if (this._config.preservePinned && message.pinned) {
            console.log(`📌 Skipping pinned message from ${message.author.tag}`);
            return;
        }

        const truncatedContent = message.content.slice(0, 50) + (message.content.length > 50 ? '...' : '');
        const timeout = this._config.timeoutSeconds * 1000;
        console.log(
            `📝 Scheduled deletion for message in #${
                (message.channel as TextChannel).name
            }: "${truncatedContent}" in ${timeout}ms`
        );

        const timer = setTimeout(() => this.deleteMessage(message), timeout);

        // Store the timer so we can cancel it if needed
        this.messageTimers.set(message.id, timer);
    }

    public handleMessageDelete(message: OmitPartialGroupDMChannel<Message<boolean> | PartialMessage>) {
        this.checkStopped();
        const timer = this.messageTimers.get(message.id);
        if (timer) {
            clearTimeout(timer);
            this.messageTimers.delete(message.id);
            console.log(`🧹 Cleaned up timer for manually deleted message`);
        }
    }

    private deleteMessage(message: Message) {
        this.checkStopped();
        try {
            deleteMessageSafely(message);
        } catch (error) {
            console.error(`❌ Failed to delete message:`, (error as Error).message);
        } finally {
            // Clean up the timer reference
            this.messageTimers.delete(message.id);
        }
    }

    // Cleans up expired messages that may have been missed (e.g., bot was offline)
    private async cleanupExpiredMessages() {
        console.log(`🧹 Starting cleanup of expired messages in #${this._config.channelId}...`);

        this.checkStopped();
        const channel = this.client.channels.cache.get(this._config.channelId) as TextChannel;
        const cutoffTime = Date.now() - this._config.timeoutSeconds * 1000;
        const cutoffDate = new Date(cutoffTime);

        while (true) {
            const { messages, next } = await this.getDeletableMessages(channel, this.config.createdAt, cutoffDate);
            if (messages.length === 0) break;

            for (const message of messages) {
                this.deleteMessage(message);
            }

            // If there's a next page, wait for it to resolve
            if (next) {
                await next();
            } else {
                break;
            }
        }

        const nextInterval = getPeriodicCleanupInterval(this._config.timeoutSeconds * 1000);
        console.log(`⏲️ Next periodic cleanup in ${Math.round(nextInterval / 1000)} seconds`);
        this.cleanupTimer = setTimeout(() => this.cleanupExpiredMessages(), nextInterval);
    }

    private async getDeletableMessages(channel: TextChannel, minDate: Date, maxDate: Date) {
        const maxTime = maxDate.getTime();
        const minTime = minDate.getTime();

        const fetchPage = async (before?: Snowflake) => {
            const coll = await channel.messages.fetch({ limit: 100, before });
            if (coll.size === 0)
                return {
                    messages: [],
                };

            const raw = Array.from(coll.values()); // newest -> oldest
            const nextBefore = raw.at(-1)?.id ?? null;

            // Apply filters but ALWAYS compute nextBefore from the raw batch
            let filtered = raw;
            if (this.config.preservePinned) {
                filtered = filtered.filter((m) => !m.pinned);
                // Optional: warn once if a page was fully pinned
                if (filtered.length === 0) {
                    console.warn('⚠️ Page contained only pinned messages; paging deeper…');
                }
            }

            filtered = filtered.filter((m) => m.createdTimestamp < maxTime && m.createdTimestamp > minTime);

            return {
                messages: filtered,
                next: nextBefore ? () => fetchPage(nextBefore) : null,
            };
        };

        // First page
        return fetchPage();
    }

    private async cleanupChannelHistory() {
        this.checkStopped();

        if (this.config.preserveHistory) {
            console.error(
                `⚠️ Skipping initial cleanup of existing messages in #${this.config.channelId} because preserveHistory is enabled.`
            );
            return;
        }

        const channelName =
            this.client.channels.cache.get(this._config.channelId)?.toString() || this._config.channelId;
        console.log(`\n🧹 Starting cleanup of existing old messages for channel ${channelName}...`);

        const channel = this.client.channels.cache.get(this._config.channelId) as TextChannel;
        const cutoffTime = Date.now() - this._config.timeoutSeconds * 1000;
        const cutoffDate = new Date(cutoffTime);

        let deletedCount = 0;
        let totalFetched = 0;

        // Fetch messages in batches (Discord API limit is 100 per request)
        let lastMessageId: string | undefined;

        // TODO: Has a bug where if there are more than 100 non-deletable messages will look infinitely
        // TODO: WIll not delete messages that newer than teh cutoff after this script completes, since they have no timers
        let iterations = 0;
        while (true && iterations < 50) {
            iterations++;
            const fetchOptions: FetchMessagesOptions = { limit: 100 };
            if (lastMessageId) {
                fetchOptions.before = lastMessageId;
            }
            const messages = await channel.messages.fetch(fetchOptions);

            if (messages.size === 0) break; // No more messages

            totalFetched += messages.size;
            console.log(`📥 Fetched ${messages.size} messages (total: ${totalFetched})`);

            // Filter messages older than cutoff time and not from bots
            const messagesToDelete = messages.filter((msg) => {
                const isOld = msg.createdTimestamp < cutoffTime;
                const isNotPinned = !msg.pinned;

                return isOld && isNotPinned;
            });

            if (messagesToDelete.size === 0 && messages.size < 100) {
                console.log(`✅ No more messages to delete.`);
                break;
            }

            // Delete messages with safety delays
            if (messagesToDelete.size > 0) {
                console.log(`🎯 Found ${messagesToDelete.size} messages to delete in this batch`);

                // Separate messages into bulk deletable (< 14 days) and individual delete (> 14 days)
                const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
                const bulkDeletable = messagesToDelete.filter((msg) => msg.createdTimestamp > twoWeeksAgo);
                const individualDelete = messagesToDelete.filter((msg) => msg.createdTimestamp <= twoWeeksAgo);

                if (bulkDeletable.size > 0) {
                    console.log(
                        `⏳ Deleting ${bulkDeletable.size} messages via bulk delete in 3 seconds... (Ctrl+C to cancel)`
                    );
                    await new Promise((resolve) => setTimeout(resolve, 3000)); // 3 second delay before bulk delete

                    // Bulk delete recent messages (more efficient)
                    if (bulkDeletable.size > 1) {
                        try {
                            await channel.bulkDelete(bulkDeletable);
                            deletedCount += bulkDeletable.size;
                            console.log(`🗑️ Bulk deleted ${bulkDeletable.size} messages`);
                        } catch (error) {
                            console.error(`❌ Bulk delete failed:`, (error as Error).message);
                            // Fall back to individual deletion
                            console.log(`🔄 Falling back to individual deletion...`);
                            for (const msg of bulkDeletable.values()) {
                                try {
                                    await msg.delete();
                                    deletedCount++;
                                    console.log(`🗑️ Deleted message from ${msg.author.tag}`);
                                    await new Promise((resolve) => setTimeout(resolve, 500)); // Rate limit protection
                                } catch (err) {
                                    console.error(`❌ Failed to delete message:`, (err as Error).message);
                                }
                            }
                        }
                    } else if (bulkDeletable.size === 1) {
                        try {
                            await bulkDeletable.first()!.delete();
                            deletedCount++;
                            console.log(`🗑️ Deleted 1 message`);
                        } catch (error) {
                            console.error(`❌ Failed to delete message:`, (error as Error).message);
                        }
                    }
                }

                // Individual delete for old messages (> 14 days)
                if (individualDelete.size > 0) {
                    console.log(`⏳ Individually deleting ${individualDelete.size} old messages (>14 days)...`);
                    for (const msg of individualDelete.values()) {
                        try {
                            await msg.delete();
                            deletedCount++;
                            console.log(`🗑️ Deleted old message from ${msg.author.tag}`);
                            await new Promise((resolve) => setTimeout(resolve, 1000)); // 1 second delay between individual deletes
                        } catch (error) {
                            console.error(`❌ Failed to delete old message:`, (error as Error).message);
                        }
                    }
                }

                // Delay between batches
                if (messagesToDelete.size > 0) {
                    console.log(`⏸️ Waiting 2 seconds before next batch...`);
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                }
            }
        }

        console.log(`✅ Initial cleanup complete!`);
    }

    public start() {
        this.verifyPerms();
        this.cleanupTimer = setTimeout(() => this.cleanupExpiredMessages(), 500);

        if (!this._config.preserveHistory) {
            this.cleanupChannelHistory();
        }
    }

    public stop() {
        this.stopped = true;
        this.messageTimers.forEach((timer) => clearTimeout(timer));
        this.messageTimers.clear();
        if (this.cleanupTimer) {
            clearTimeout(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        console.log(`🛑 Stopped flash chat for ${this._config.guildId}/${this._config.channelId}`);
    }

    private verifyPerms() {
        const channel = this.client.channels.cache.get(this._config.channelId) as TextChannel;

        if (!channel) {
            throw new Error(`Channel ID ${this._config.channelId} not found in cache.`);
        }

        const botMember = channel.guild.members.me;
        if (!botMember) {
            throw new Error(`Bot is not a member of the guild ${channel.guild.name}.`);
        }

        if (!botMember.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
            throw new Error(`Bot lacks 'Manage Messages' permission in channel ${channel.name}.`);
        }

        console.log(`✅ Verified permissions in channel #${channel.name}`);
    }

    private checkStopped() {
        if (this.stopped) {
            throw new Error(
                `Flash chat instance for ${this._config.guildId}/${this._config.channelId} has been stopped.`
            );
        }
    }
}
