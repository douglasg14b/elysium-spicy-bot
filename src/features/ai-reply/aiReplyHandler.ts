import { Events, Message, TextChannel } from 'discord.js';
import { DISCORD_CLIENT } from '../../discordClient';
import { aiService } from './aiService';
import {
    shouldRespondToMessage,
    extractMentionContent,
    fetchRecentMessages,
    isReplyToBotMessage,
} from './messageUtils';
import { runWorkflow } from './newAiReplyStuff';
import { userInteractionTracker } from './antiAbuse/userInteractionTracker';
import { AntiAbuseService, antiAbuseService } from './antiAbuse/antiAbuseService';
import { aiPendingReplyTracker } from './antiAbuse/aiPendingReplyTracker';
import { createCooldownEmbed, createModerationActionEmbed, createWarningEmbed } from './antiAbuse/antiAbuseEmbeds';
import { userWarningsTracker } from './antiAbuse/userWarningsTracker';

export function initAIReply(): void {
    DISCORD_CLIENT.on(Events.MessageCreate, async (message: Message) => {
        try {
            await handleAIReply(message);
        } catch (error) {
            console.error('Error in AI reply handler:', error);
        }
    });

    console.log('✅ AI Reply feature initialized');
}

function validateAndCleanReply(reply: string): string {
    // Handle null/undefined
    if (!reply) {
        console.warn('Received empty reply from AI, providing default response.');
        return "Hmph! I'm feeling speechless right now... which is rare for a brat like me! 🙄";
    }

    // Remove any potential problematic characters
    let cleaned = reply
        .replace(/[\x00-\x08\x0E-\x1F\x7F]/g, '') // Remove control characters
        .replace(/\u200B/g, '') // Remove zero-width spaces
        .trim();

    // Discord message limit is 2000 characters
    if (cleaned.length > 2000) {
        cleaned = cleaned.substring(0, 1950) + '... *rolls eyes* Too wordy, even for me! 🙄';
    }

    // Ensure we have some content
    if (cleaned.length === 0) {
        console.warn('Received empty cleaned reply from AI, providing default response.');
        return 'Well, that was awkward... my brain just went blank! 😤';
    }

    // Check for common problematic patterns that might cause form body errors
    if (cleaned.includes('@everyone') || cleaned.includes('@here')) {
        cleaned = cleaned.replace(/@everyone/g, '@​everyone').replace(/@here/g, '@​here');
    }

    return cleaned;
}

async function handleAIReply(message: Message): Promise<void> {
    // console.log('Received message for AI reply handling:', message.content);

    // Get bot's user ID
    const botUser = DISCORD_CLIENT.user;
    if (!botUser) {
        console.error('Bot user not available');
        return;
    }

    // Check if we should respond to this message
    const shouldRespond = shouldRespondToMessage(message, botUser.id);
    if (!shouldRespond) {
        return;
    }

    // For replies, double-check that it's actually replying to the bot
    if (message.reference && message.reference.messageId) {
        const isActualReplyToBot = await isReplyToBotMessage(message, botUser.id);
        if (!isActualReplyToBot) {
            return;
        }
    }

    // Make sure it's a text channel
    if (!message.channel.isTextBased()) {
        return;
    }

    if (!message.guildId) {
        console.error('Message guild ID is undefined');
        return;
    }

    const channel = message.channel as TextChannel;

    try {
        const sendTyping = async () => {
            await channel.sendTyping();
        };
        // Show typing indicator
        await sendTyping();

        // Record Interaction
        userInteractionTracker.recordUserInteraction(message.author.id, message.guildId);

        const antiAbuseResult = antiAbuseService.processInteractionAttempt({
            userId: message.author.id,
            guildId: message.guildId,
            channelId: channel.id,
        });

        // If they are not allowed to interact, reply with the warning or cooldown message
        // If they pass this, that means they are allowed to proceed
        // This also means they don't have any pending messages
        if (!antiAbuseResult.allowed) {
            if (antiAbuseResult.cooldown) {
                message.reply({
                    embeds: [
                        createCooldownEmbed(
                            antiAbuseResult.message,
                            AntiAbuseService.generateCooldownTimeRemaining(antiAbuseResult.cooldown)
                        ),
                    ],
                });
            } else {
                message.reply({
                    embeds: [createWarningEmbed(antiAbuseResult.message)],
                });
            }
            // message.reply(antiAbuseResult.message);
            return;
        }

        aiPendingReplyTracker.addPendingReply(message.author.id, channel.id, message.guildId);

        // Check if this is a reply to the bot's message
        const isReplyToBot = await isReplyToBotMessage(message, botUser.id);

        // Extract content based on whether it's a mention or reply
        let messageContent: string;
        if (isReplyToBot) {
            // For replies to bot messages, use the full content
            messageContent = message.content.trim();
        } else {
            // For @mentions, remove the bot mention
            messageContent = extractMentionContent(message, botUser.id);
        }

        if (!messageContent) {
            // If there's no content, respond with a bratty message
            const response = isReplyToBot
                ? "You're just gonna reply to me with nothing to say? How bratty of you! 😤"
                : 'What? You just gonna @ me and not say anything? Rude! 🙄';
            await message.reply(response);
            aiPendingReplyTracker.removePendingReply(message.author.id, channel.id);
            return;
        }

        const newAiReply = await runWorkflow({ input_as_text: messageContent, sendTyping }, aiService.openAiClient);

        // TODO: Cleanup, we should really be getting the warning issued back here to send off
        // Instead of the roundabout state crap we're doing later on
        if (newAiReply.wasModerationAbuse) {
            antiAbuseService.recordAbuseModerationWarning(message.author.id, message.guildId, message.channelId);
        }

        // // Fetch recent messages for context
        // const recentMessages = await fetchRecentMessages(channel, message);

        // // Get referenced bot message if this is a reply
        // let referencedBotMessage: string | undefined;
        // if (isReplyToBot && message.reference?.messageId) {
        //     try {
        //         const referencedMessage = await channel.messages.fetch(message.reference.messageId);
        //         referencedBotMessage = referencedMessage.content;
        //     } catch (error) {
        //         console.error('Error fetching referenced bot message:', error);
        //     }
        // }

        // // Generate AI response
        // const aiReply = await aiService.generateReply({
        //     mentionedMessage: messageContent,
        //     mentioningUser: message.author.displayName || message.author.username,
        //     recentMessages,
        //     channelName: channel.name,
        //     isReplyToBot,
        //     referencedBotMessage,
        // });

        // Validate and clean the AI reply before sending
        const cleanedReply = validateAndCleanReply(newAiReply.output_text);

        // Reply to the message with error handling
        try {
            if (antiAbuseService.isUserOnCooldown(message.author.id, message.guildId)) {
                console.log(
                    `User ${message.author.id} was placed on cooldown after generating reply. Not sending message.`
                );
            } else {
                await message.reply(cleanedReply);
                aiPendingReplyTracker.removePendingReply(message.author.id, channel.id);
            }

            // After LLM reply, send warning if moderation abuse was detected
            // This is hacky and gross and needs cleaning up
            if (newAiReply.wasModerationAbuse) {
                const isOnCooldown = antiAbuseService.isUserOnCooldown(message.author.id, message.guildId);
                if (isOnCooldown) {
                    message.reply({
                        embeds: [
                            createCooldownEmbed(
                                isOnCooldown.message,
                                AntiAbuseService.generateCooldownTimeRemaining(isOnCooldown)
                            ),
                        ],
                    });
                } else {
                    const latestWarning = userWarningsTracker
                        .getUserWarnings(message.author.id, message.guildId, 'abuse')
                        .at(-1);
                    if (!latestWarning) {
                        console.error('Expected a warning to be recorded but none found');
                    } else {
                        await message.reply({
                            embeds: [createModerationActionEmbed(latestWarning.warningMessage)],
                        });
                    }
                }
            }
        } catch (replyError: any) {
            console.error('Error sending AI reply:', replyError);
            aiPendingReplyTracker.removePendingReply(message.author.id, channel.id);

            // If we get a form body error, try sending a simple fallback
            if (replyError.message?.includes('form body') || replyError.code === 50035) {
                try {
                    await message.reply('Ugh, Discord is being difficult with my response! 😤 Try asking again?');
                } catch (fallbackError) {
                    console.error('Even fallback reply failed:', fallbackError);
                } finally {
                    aiPendingReplyTracker.removePendingReply(message.author.id, channel.id);
                }
            } else {
                // Re-throw other errors to be caught by the outer catch block
                throw replyError;
            }
        }
    } catch (error) {
        console.error('Error generating AI reply:', error);
        console.log('Full Stack Trace:', (error as Error).stack);

        // Send a fallback bratty response
        try {
            await message.reply('Ugh, my circuits are being extra bratty right now! 😤 Try again in a sec~');
        } catch (replyError) {
            console.error('Error sending fallback reply:', replyError);
        } finally {
            aiPendingReplyTracker.removePendingReply(message.author.id, channel.id);
        }
    }
}
