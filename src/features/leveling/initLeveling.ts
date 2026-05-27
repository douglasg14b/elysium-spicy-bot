import { Events } from 'discord.js';
import { interactionsRegistry } from '../../features-system/commands';
import { DISCORD_CLIENT } from '../../discordClient';
import { levelingConfigCommand, handleLevelingConfigCommand } from './commands/levelingConfigCommand';
import { handleLevelCommand, levelCommand } from './commands/levelCommand';
import { LevelingService } from './levelingService';

let levelingInitialized = false;

export function initLeveling(): void {
    if (levelingInitialized) {
        return;
    }

    levelingInitialized = true;

    interactionsRegistry.register(levelingConfigCommand, handleLevelingConfigCommand);
    interactionsRegistry.register(levelCommand, handleLevelCommand);

    const levelingService = new LevelingService(DISCORD_CLIENT);

    DISCORD_CLIENT.on(Events.MessageCreate, (message) => {
        void levelingService.handleMessageCreate(message).catch((error) => {
            console.error('[leveling] Error handling message create:', error);
        });
    });

    DISCORD_CLIENT.on(Events.MessageReactionAdd, (reaction, user) => {
        void levelingService.handleReactionAdd(reaction, user).catch((error) => {
            console.error('[leveling] Error handling reaction add:', error);
        });
    });
}

export function resetLevelingInitializationForTests(): void {
    levelingInitialized = false;
}
