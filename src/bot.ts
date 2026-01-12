import { Events, InteractionType } from 'discord.js';
import { DISCORD_CLIENT } from './discordClient';
import { BOT_CONFIG } from './botConfig';
import { interactionsRegistry, registerCommandsWithDiscord } from './features-system/commands';
import { flashChatCommand, handleFlashChatCommand } from './features/flash-chat/flashChatCommand';
import { initFlashChat } from './features/flash-chat';
import { flagBotReady } from './healthcheck/botHearthbeat';
import { deployTicketSystemCommand, handleDeployTicketSystem, initTicketsFeature } from './features/tickets';
import { initAIReply } from './features/ai-reply';
import { initBirthdayFeature } from './features/birthday-tracker';

interactionsRegistry.register(flashChatCommand, handleFlashChatCommand);
interactionsRegistry.register(deployTicketSystemCommand, handleDeployTicketSystem);

// Initialize ticket system handlers
initTicketsFeature();

// Initialize birthday tracker handlers
initBirthdayFeature();

// Initialize AI reply feature
initAIReply();

// Register with Discord API
await registerCommandsWithDiscord(interactionsRegistry.getSlashCommandBuilders());

// Bot ready event
DISCORD_CLIENT.once(Events.ClientReady, async (readyClient) => {
    console.log(`✅ Bot is ready! Logged in as ${readyClient.user.tag}`);
    console.log(`🏠 Bot is in ${readyClient.guilds.cache.size} server(s)`);
    flagBotReady();

    // List all servers and channels the bot can see
    readyClient.guilds.cache.forEach((guild) => {
        console.log(`🏠 Server: ${guild.name} (ID: ${guild.id})`);
        const textChannels = guild.channels.cache.filter((ch) => ch.isTextBased());
        console.log(`📝 Text channels: ${textChannels.size}`);
    });

    await initFlashChat();
});

// Emulate the "hello there" behavior Kat mentioned
DISCORD_CLIENT.on(Events.MessageCreate, (message) => {
    if (message.content === 'hello there') {
        const embed = {
            title: 'Why hello there!',
            image: { url: 'https://media.tenor.com/TQMe1Q1smGIAAAPo/general-kenobi-general-grievous.mp4' },
            color: 0x0099ff,
        };

        message.reply('Why hello there! https://media.tenor.com/TQMe1Q1smGIAAAPo/general-kenobi-general-grievous.mp4');
    }
});

DISCORD_CLIENT.on(Events.VoiceStateUpdate, (oldState, newState) => {
    newState.member;
});

// Handle errors gracefully
DISCORD_CLIENT.on(Events.Error, (error: Error) => {
    console.error('❌ Discord client error:', error);
});

process.on('unhandledRejection', (error: Error) => {
    console.error('❌ Unhandled promise rejection:', error);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down bot...');

    // // Clear all pending timers
    // messageTimers.forEach((timer) => clearTimeout(timer));
    // messageTimers.clear();

    DISCORD_CLIENT.destroy();
    process.exit(0);
});

// Login with your bot token
DISCORD_CLIENT.login(BOT_CONFIG.botToken).catch((error) => {
    console.error('❌ Failed to login:', error.message);
    process.exit(1);
});

// Set up listener
DISCORD_CLIENT.on(Events.InteractionCreate, async (interaction) => {
    try {
        await interactionsRegistry.handleInteraction(interaction);
    } catch (error) {
        switch (interaction.type) {
            case InteractionType.ApplicationCommand:
                console.error(`🚨🚨 Fatal Error handling command ${interaction.commandName}:`, error);
                break;
            case InteractionType.ModalSubmit:
                console.error(`🚨🚨 Fatal Error handling modal submit ${interaction.customId}:`, error);
                break;
            case InteractionType.MessageComponent:
                console.error(`🚨🚨 Fatal Error handling message component ${interaction.customId}:`, error);
                break;
            default:
                console.error(`🚨🚨 Fatal Error handling interaction of type ${interaction.type}:`, error);
        }
    }
});
