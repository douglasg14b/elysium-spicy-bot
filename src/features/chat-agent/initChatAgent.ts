import { Events } from 'discord.js';
import { DISCORD_CLIENT } from '../../discordClient';
import { createPerGuildQueue } from '../../shared/perGuildQueue';
import { CHAT_AGENT_MODEL } from '../../environment';
import { chatModel } from './agent/chatModel';
import { handleChatMessage, type ChatAgentDependencies } from './chatAgentHandler';
import { ChatRateLimiter } from './safety/rateLimit';
import { ChatSessionStore } from './session/chatSessionStore';

/** Listens for messages addressed to the bot and answers them with the chat agent. */
export function initChatAgent(): void {
    const deps: ChatAgentDependencies = {
        sessions: new ChatSessionStore(),
        channelQueue: createPerGuildQueue(),
        pendingTurns: new Map(),
        rateLimiter: new ChatRateLimiter(),
        model: chatModel(),
    };

    DISCORD_CLIENT.on(Events.MessageCreate, (message) => {
        const botUser = DISCORD_CLIENT.user;
        if (!botUser) return;
        handleChatMessage(message, botUser, deps).catch((error: unknown) =>
            console.error('[chat-agent] message handler failed:', error)
        );
    });

    console.log(`✅ Chat agent initialized (model ${CHAT_AGENT_MODEL})`);
}
