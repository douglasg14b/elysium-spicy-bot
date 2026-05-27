import { EmbedBuilder, type User } from 'discord.js';
import type { UserLevelProfile } from './userLevelProfile';
import { formatActivityTotalsLine, formatXpProgressBar } from './userLevelProfile';

export function buildUserLevelEmbed(profile: UserLevelProfile, targetUser: User): EmbedBuilder {
    if (!profile.hasAnyActivity) {
        return new EmbedBuilder()
            .setColor(0x5865f2)
            .setAuthor({
                name: targetUser.displayName,
                iconURL: targetUser.displayAvatarURL(),
            })
            .setDescription(`${targetUser} has no recorded leveling activity in this server yet.`)
            .setTimestamp();
    }

    const progressBar = formatXpProgressBar(profile.xpWithinLevel, profile.xpForCurrentLevelStep);

    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({
            name: targetUser.displayName,
            iconURL: targetUser.displayAvatarURL(),
        })
        .setDescription(
            [
                `**Level ${profile.level}** · ${profile.totalXp.toLocaleString()} total XP`,
                progressBar,
                `${profile.xpToNextLevel.toLocaleString()} XP to next level`,
            ].join('\n')
        )
        .addFields(
            {
                name: `Recent activity (last ${profile.recentPeriodDays} days)`,
                value: formatActivityTotalsLine(profile.recentActivity),
                inline: false,
            },
            {
                name: 'Total activity',
                value: formatActivityTotalsLine(profile.totalActivity),
                inline: false,
            }
        )
        .setTimestamp();
}
