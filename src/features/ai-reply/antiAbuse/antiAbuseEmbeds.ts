import { EmbedBuilder, ColorResolvable } from 'discord.js';

/**
 * Creates a warning embed for anti-abuse messages
 * Style: Clean, warning-themed with yellow/orange colors
 */
export function createWarningEmbed(message: string, title?: string): EmbedBuilder {
    return new EmbedBuilder()
        .setColor('#FF8C00' as ColorResolvable) // Orange color
        .setTitle(title || `⚠️ Warning ⚠️`)
        .setDescription(message)
        .setTimestamp()
        .setFooter({
            text: 'Anti-abuse system',
        });
}

/**
 * Creates a cooldown embed for anti-abuse messages
 * Style: More stern, red-themed for cooldowns
 */
export function createCooldownEmbed(message: string, timeRemaining: string): EmbedBuilder {
    return new EmbedBuilder()
        .setColor('#DC143C' as ColorResolvable) // Crimson red
        .setTitle('🛑 Blocked 🛑')
        .setDescription(`${message}`)
        .setTimestamp()
        .setFooter({
            text: `Time remaining: ${timeRemaining} | Anti-abuse system`,
        });
}

/**
 * Creates a severe moderation action embed for serious content violations
 * Style: Dark red/black theme for egregious content (violence, illegal content, etc.)
 */
export function createModerationActionEmbed(message: string, actionTaken?: string): EmbedBuilder {
    return (
        new EmbedBuilder()
            .setColor('#8B0000' as ColorResolvable) // Dark red
            .setTitle('🚨 CONTENT VIOLATION DETECTED 🚨')
            .setDescription(`**${message}**`)
            // .addFields([
            //     {
            //         name: '⚖️ Action Taken',
            //         value: actionTaken || 'Content blocked and flagged for review',
            //         inline: false
            //     },
            //     {
            //         name: '📋 Note',
            //         value: 'Serious violations may result in permanent restrictions or reporting to Discord Trust & Safety.',
            //         inline: false
            //     }
            // ])
            .setTimestamp()
            .setFooter({
                text: 'Content Moderation System',
            })
    );
}
