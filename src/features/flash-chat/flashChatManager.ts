import { Client, Events, Message, OmitPartialGroupDMChannel, PartialMessage } from 'discord.js';
import { FlashChatInstance } from './flashChatInstance';
import { FlashChatConfig } from './data/flashChatSchema';
import { flashChatRepo } from './data/flashChatRepo';
import { DISCORD_CLIENT } from '../../discordClient';

export class FlashChatManager {
    /** guildId -> channelId -> FlashChatInstance */
    private _instances: Map<string, Map<string, FlashChatInstance>> = new Map();
    private client: Client;

    constructor(client: Client) {
        this.client = client;
    }

    public get instances() {
        return this._instances;
    }

    // public async getInstance(guildId: string, channelId: string): Promise<FlashChatInstance | undefined> {
    //     // First check if we already have the instance in memory
    //     // If not, and a config exists, create one
    //     // THis should be an incredibly rare, if not "supposedly impossible" situation, only bugs will cause this
    //     if (!this.instances.has(guildId) && !this.instances.get(guildId)?.has(channelId)) {
    //         const existingConfig = await flashChatRepo.get(guildId, channelId);

    //         if (!existingConfig) {
    //             throw new Error(`No flash chat config found for guild ${guildId} and channel ${channelId}`);
    //         }

    //         console.warn(
    //             `⚠️ Flash chat instance for guild ${guildId} and channel ${channelId} was missing but config found. Restarting instance.`
    //         );
    //         return this.startInstance(existingConfig);
    //     }

    //     const instance = this.instances.get(guildId)?.get(channelId);
    //     return instance;
    // }

    public startInstance(config: FlashChatConfig): FlashChatInstance {
        if (this.has(config.guildId, config.channelId)) {
            throw new Error(`Flash chat instance already exists for channel ID ${config.channelId}`);
        }

        if (!this._instances.has(config.guildId)) {
            this._instances.set(config.guildId, new Map());
        }

        const instance = new FlashChatInstance(config, this.client);
        this._instances.get(config.guildId)?.set(config.channelId, instance);

        instance.start();

        return instance;
    }

    public stopInstance(guildId: string, channelId: string) {
        const guildInstances = this._instances.get(guildId);

        if (!guildInstances) {
            throw new Error(`No flash chat instances found for guild ${guildId}`);
        }

        const instance = guildInstances.get(channelId);
        if (!instance) {
            throw new Error(`No flash chat instance found for guild ${guildId} and channel ${channelId}`);
        }

        instance.stop();
        guildInstances.delete(channelId);
    }

    public set(guildId: string, channelId: string, instance: FlashChatInstance) {
        if (!this._instances.has(guildId)) {
            this._instances.set(guildId, new Map());
        }

        this._instances.get(guildId)?.set(channelId, instance);
    }

    public has(guildId: string, channelId: string): FlashChatInstance | undefined {
        return this.getInstance(guildId, channelId);
    }

    public delete(guildId: string, channelId: string) {
        const guildInstances = this._instances.get(guildId);

        if (!guildInstances) {
            throw new Error(`No flash chat instances found for guild ${guildId}`);
        }

        const instance = guildInstances.get(channelId);
        if (instance) {
            instance.stop();
        }

        guildInstances.delete(channelId);
    }

    // We do this so unsubscribers actually work
    private boundOnCreate = (m: Message) => this.onMessageCreate(m);
    private boundOnDelete = (m: OmitPartialGroupDMChannel<Message<boolean> | PartialMessage>) =>
        this.onMessageDelete(m);

    onMessageCreate(message: Message) {
        // Ignore messages not in a guild
        if (!message.guildId) return;

        const instance = this.getInstance(message.guildId, message.channelId);
        if (instance) {
            instance.handleMessageCreate(message);
        }
    }

    onMessageDelete(message: OmitPartialGroupDMChannel<Message<boolean> | PartialMessage>) {
        // Ignore messages not in a guild
        if (!message.guildId) return;

        const instance = this.getInstance(message.guildId, message.channelId);
        if (instance) {
            instance.handleMessageDelete(message);
        }
    }

    getInstance(guildId: string, channelId: string): FlashChatInstance | undefined {
        return this._instances.get(guildId)?.get(channelId);
    }

    init() {
        this.client.on(Events.MessageCreate, this.boundOnCreate);
        this.client.on(Events.MessageDelete, this.boundOnDelete);
    }
}

export const flashChatManager = new FlashChatManager(DISCORD_CLIENT);
