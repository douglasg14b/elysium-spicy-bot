import { REST, Routes } from 'discord.js';
import { DISCORD_APP_ID, DISCORD_BOT_TOKEN } from '../../environment';
import { SupportedInteractionBuilder } from './types';

export async function registerCommandsWithDiscord(commands: SupportedInteractionBuilder[]): Promise<void> {
    const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);

    try {
        console.log('🔄 Started refreshing application (/) commands.');

        await rest.put(Routes.applicationCommands(DISCORD_APP_ID), {
            body: commands.map((command) => command.toJSON()),
        });

        console.log('✅ Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('❌ Error registering commands:', error);
    }
}
