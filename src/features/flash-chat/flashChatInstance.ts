import {
    Client,
    Events,
    FetchMessagesOptions,
    Message,
    OmitPartialGroupDMChannel,
    PartialMessage,
    PermissionsBitField,
    TextChannel,
} from 'discord.js';
import { deleteMessageSafely } from './utils';
import { FlashChatConfig } from './data/flashChatSchema';

export class FlashChatInstance {
    private _config: FlashChatConfig;
    private client: Client;
    private messageTimers: Map<string, NodeJS.Timeout> = new Map();

    constructor(config: FlashChatConfig, client: Client) {
        this._config = config;
        this.client = client;
    }

    public get channelId() {
        return this._config.channelId;
    }

    public get config() {
        return this._config;
    }

    private deleteMessage(message: Message) {
        try {
            deleteMessageSafely(message);
        } catch (error) {
            console.error(`❌ Failed to delete message:`, (error as Error).message);
        } finally {
            // Clean up the timer reference
            this.messageTimers.delete(message.id);
        }
    }

    private handleNewMessage(message: Message) {
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

    private handleMessageDeleted(message: OmitPartialGroupDMChannel<Message<boolean> | PartialMessage>) {
        const timer = this.messageTimers.get(message.id);
        if (timer) {
            clearTimeout(timer);
            this.messageTimers.delete(message.id);
            console.log(`🧹 Cleaned up timer for manually deleted message`);
        }
    }

    private async cleanupOldMessages() {
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
        this.client.on(Events.MessageCreate, this.handleNewMessage.bind(this));
        this.client.on(Events.MessageDelete, this.handleMessageDeleted.bind(this));

        if (!this._config.preserveHistory) {
            this.cleanupOldMessages();
        }
    }

    public stop() {
        this.client.off(Events.MessageCreate, this.handleNewMessage.bind(this));
        this.messageTimers.forEach((timer) => clearTimeout(timer));
        this.messageTimers.clear();
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
}
