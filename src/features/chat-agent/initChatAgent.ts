import { Events } from 'discord.js';
import { DISCORD_CLIENT } from '../../discordClient';
import { createPerGuildQueue } from '../../shared/perGuildQueue';
import { CHAT_AGENT_MODEL } from '../../environment';
import { chatModel } from './agent/chatModel';
import { handleChatMessage, type ChatAgentDependencies } from './chatAgentHandler';
import { ChatRateLimiter } from './safety/rateLimit';
import { ChatSessions, SESSION_SWEEP_INTERVAL_MS } from './session/chatSessions';

/** Listens for messages addressed to the bot and answers them with the chat agent. */
export function initChatAgent(): void {
    const sessions = new ChatSessions();
    const deps: ChatAgentDependencies = {
        sessions,
        channelQueue: createPerGuildQueue(),
        pendingTurns: new Map(),
        rateLimiter: new ChatRateLimiter(),
        model: chatModel(),
    };

    // A message deleted in Discord leaves the sessions too. Partial messages arrive (`Partials.Message`), so an uncached one does as well.
    const forgetDeleted = (guildId: string | null, messageIds: readonly string[]) => {
        if (!guildId) return;
        sessions.forgetDeleted(guildId, messageIds).catch((error: unknown) => console.error('[chat-agent] could not forget deleted messages:', error));
    };
    DISCORD_CLIENT.on(Events.MessageDelete, (message) => forgetDeleted(message.guildId, [message.id]));
    DISCORD_CLIENT.on(Events.MessageBulkDelete, (messages, channel) => forgetDeleted(channel.guildId, [...messages.keys()]));

    DISCORD_CLIENT.on(Events.MessageCreate, (message) => {
        const botUser = DISCORD_CLIENT.user;
        if (!botUser) return;
        handleChatMessage(message, botUser, deps).catch((error: unknown) =>
            console.error('[chat-agent] message handler failed:', error)
        );
    });

    // Sessions past their day go even where nobody talks to the bot any more. Never holds the process open.
    setInterval(
        () => void sessions.sweep().catch((error: unknown) => console.error('[chat-agent] could not sweep ended sessions:', error)),
        SESSION_SWEEP_INTERVAL_MS
    ).unref();

    console.log(`✅ Chat agent initialized (model ${CHAT_AGENT_MODEL})`);
}
