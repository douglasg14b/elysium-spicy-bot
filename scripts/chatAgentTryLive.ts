/**
 * Ask the chat agent one question against a real server, without posting anything.
 *
 *   pnpm chat-agent:try-live --channel <channelId> --as <userId> [--model <openrouter slug>] "question"
 *
 * Needs the bot's full env in `.env.local` (Discord token, database); for a model-only
 * comparison that needs just the OpenRouter key, use `pnpm chat-agent:try`.
 *
 * Logs the bot in, reads the channel's recent history as the
 * agent would, adds the question as if `--as` had just said it, runs one turn with the
 * real tools, and prints each tool call, its result and the reply. Comparing models is
 * `--model` (or `CHAT_AGENT_MODEL`). The bot's live process is untouched: Discord allows
 * a second gateway session on the same token.
 */
import { parseArgs } from 'node:util';
import type { ModelMessage } from 'ai';
import { DISCORD_CLIENT } from '../src/discordClient';
import { CHAT_AGENT_MODEL, DISCORD_BOT_TOKEN } from '../src/environment';
import { chatModel } from '../src/features/chat-agent';
import { runReviewedTurn } from '../src/features/chat-agent/agent/runReviewedTurn';
import { historyToModelMessages, type HistoryMessage } from '../src/features/chat-agent/session/historyToModelMessages';
import { HISTORY_MESSAGE_LIMIT, toHistoryMessage } from '../src/features/chat-agent/session/discordHistory';
import { buildChatTools } from '../src/features/chat-agent/tools/buildChatTools';
import { buildChatToolContext, findLiveTicket } from '../src/features/chat-agent/tools/chatToolContext';

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        channel: { type: 'string' },
        as: { type: 'string' },
        model: { type: 'string' },
    },
});

const question = positionals.join(' ').trim();
if (!values.channel || !values.as || !question) {
    console.error('Usage: pnpm chat-agent:try-live --channel <channelId> --as <userId> [--model <slug>] "question"');
    process.exit(1);
}
const channelId = values.channel;
const askerId = values.as;
const modelId = values.model ?? CHAT_AGENT_MODEL;

function printStep(message: ModelMessage): void {
    if (message.role === 'assistant' && typeof message.content !== 'string') {
        for (const part of message.content) {
            if (part.type === 'tool-call') console.log(`→ ${part.toolName}(${JSON.stringify(part.input)})`);
        }
    }
    if (message.role === 'tool') {
        for (const part of message.content) {
            if (part.type === 'tool-result') {
                const shown = JSON.stringify(part.output).slice(0, 600);
                console.log(`← ${part.toolName}: ${shown}${shown.length === 600 ? ' …' : ''}`);
            }
        }
    }
}

async function main(): Promise<void> {
    await DISCORD_CLIENT.login(DISCORD_BOT_TOKEN);
    const botUser = DISCORD_CLIENT.user;
    if (!botUser) throw new Error('Logged in without a bot user');

    const channel = await DISCORD_CLIENT.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
        throw new Error(`${channelId} is not a server text channel the bot can see`);
    }
    const asker = await channel.guild.members.fetch(askerId);
    const context = await buildChatToolContext(channel, asker, await findLiveTicket(channel.id));

    // Not `readChannelHistory`: the question is not a real message there is to read up to.
    // Same window, filter and mapping otherwise.
    const recent = context.viewersCanReadHistory ? await channel.messages.fetch({ limit: HISTORY_MESSAGE_LIMIT }) : undefined;
    const asked: HistoryMessage = {
        id: 'try-question',
        authorName: asker.displayName,
        isFromThisBot: false,
        isFromOtherBot: false,
        content: question,
        createdAt: new Date(),
        replyToAuthorName: undefined,
        isBeingAnswered: true,
    };
    const history = [...(recent?.values() ?? [])]
        .reverse()
        .filter((message) => !message.system)
        .map((message) => toHistoryMessage(message, botUser.id, context.viewers, undefined))
        .concat(asked);

    const where = `#${channel.name} in ${channel.guild.name}`;
    const ticketNote = context.ticket ? ` · ticket #${context.ticket.ticketNumber}` : '';
    console.log(`model ${modelId} · ${where} · as ${asker.displayName}${ticketNote}`);
    console.log(`Q: ${question}\n`);

    const started = Date.now();
    const tools = buildChatTools(context);
    const botName = channel.guild.members.me?.displayName ?? botUser.displayName;
    const reviewed = await runReviewedTurn(
        {
            context,
            tools,
            messages: historyToModelMessages(history, () => undefined, asker.id),
            model: chatModel(modelId),
            botName,
        },
        { viewers: context.viewers, inTicket: !!context.ticket, botName, toolNames: Object.keys(tools) }
    );

    if (reviewed.redone) {
        reviewed.redone.first.responseMessages.forEach(printStep);
        console.log(`\n(turned back: ${reviewed.redone.problems.map((problem) => problem.kind).join(', ')} — tried again)\n`);
    }
    reviewed.turn.responseMessages.forEach(printStep);
    switch (reviewed.outcome) {
        case 'quiet':
            console.log('\n(stayed quiet — nothing would be posted)');
            break;
        case 'fallback':
            console.log(`\n(still wrong: ${reviewed.problems.map((problem) => problem.kind).join(', ')} — the fallback line would be posted, or nothing in a ticket)`);
            break;
        case 'post':
            console.log(reviewed.parts.map((part, index) => `\nA${reviewed.parts.length > 1 ? index + 1 : ''}: ${part}`).join(''));
            break;
    }
    console.log(`\n${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main()
    .catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        void DISCORD_CLIENT.destroy();
        process.exit();
    });
