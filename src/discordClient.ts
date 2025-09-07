import { Client, GatewayIntentBits } from 'discord.js';
import { DISCORD_BOT_TOKEN } from './environment';

const DISCORD_CLIENT = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessages,
    ],
});

DISCORD_CLIENT.token = DISCORD_BOT_TOKEN;

export { DISCORD_CLIENT };
