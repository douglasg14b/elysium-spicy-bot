import { DISCORD_BOT_TOKEN } from './environment';

interface BotConfig {
    deleteDelay: number;
    channelsToMonitor: string[];
    excludedRoles: string[];
    botToken: string;
}

export const BOT_CONFIG: BotConfig = {
    deleteDelay: 1 * 60 * 1000, // 1 minute in milliseconds
    channelsToMonitor: ['1408337626423103589'], // TODO: Have a command to configure bot for channels
    excludedRoles: [], // Add role IDs that should be excluded from auto-deletion
    botToken: DISCORD_BOT_TOKEN,
};
