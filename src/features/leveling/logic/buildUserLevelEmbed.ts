import { EmbedBuilder, type User } from 'discord.js';
import type { UserLevelProfile } from './userLevelProfile';
import { formatXpProgressBar } from './userLevelProfile';

export function buildUserLevelEmbed(profile: UserLevelProfile, targetUser: User): EmbedBuilder {
    const progressBar = formatXpProgressBar(profile.xpWithinLevel, profile.xpForCurrentLevelStep);

    return new EmbedBuilder()
        .setColor(0xe84393)
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
        .setTimestamp();
}
