import {
    AttachmentBuilder,
    ChatInputCommandInteraction,
    Guild,
    GuildMember,
    PermissionsBitField,
    SlashCommandBuilder,
} from 'discord.js';
import { commandError, commandSuccess } from '../../../features-system/commands';
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import { levelingProgressRepo } from '../data/levelingProgressRepo';
import { cardAvatarUrlFromUser } from '../cards/shared/cardAvatarUrl';
import { renderBelowThresholdCard } from '../cards/belowThresholdCard/renderBelowThresholdCard';
import {
    buildBelowThresholdReport,
    formatBelowThresholdCsv,
    formatBelowThresholdReply,
    isBelowThreshold,
    parseBelowThresholdFilter,
    type BelowThresholdFilter,
    type GuildMemberSnapshot,
} from '../logic/belowThresholdReport';
import type { LevelingProgress } from '../data/levelingProgressSchema';

export const LEVEL_REPORT_COMMAND_NAME = 'level-report';

/** Current-member reports fetch the full roster; fail loud above this size. */
export const CURRENT_SCOPE_MEMBER_LIMIT = 5_000;

const MEMBER_ID_FETCH_BATCH_SIZE = 100;

export const levelReportCommand = new SlashCommandBuilder()
    .setName(LEVEL_REPORT_COMMAND_NAME)
    .setDescription('Staff report of members below an XP or level bar')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addIntegerOption((option) =>
        option
            .setName('level')
            .setDescription('Include members below this level')
            .setRequired(false)
            .setMinValue(2)
            .setMaxValue(100)
    )
    .addIntegerOption((option) =>
        option
            .setName('xp')
            .setDescription('Include members below this total XP')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(10_000_000)
    )
    .addStringOption((option) =>
        option
            .setName('scope')
            .setDescription('Who to include (default: current members, including 0 XP)')
            .setRequired(false)
            .addChoices(
                { name: 'Current members (including 0 XP)', value: 'current' },
                { name: 'Tracked members only', value: 'tracked' }
            )
    );

export async function handleLevelReportCommand(
    interaction: ChatInputCommandInteraction
): Promise<InteractionHandlerResult> {
    if (!interaction.inGuild() || !interaction.guildId || !interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        return commandError('Level report command used outside a guild');
    }

    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        await interaction.reply({
            content: 'You need Manage Server permission to generate a leveling report.',
            ephemeral: true,
        });
        return commandError('Missing ManageGuild permission');
    }

    const parsedFilter = parseBelowThresholdFilter({
        level: interaction.options.getInteger('level'),
        xp: interaction.options.getInteger('xp'),
        scope: interaction.options.getString('scope'),
    });

    if (!parsedFilter.ok) {
        await interaction.reply({ content: parsedFilter.message, ephemeral: true });
        return commandError(parsedFilter.message);
    }

    if (
        parsedFilter.filter.scope === 'current' &&
        interaction.guild.memberCount > CURRENT_SCOPE_MEMBER_LIMIT
    ) {
        await interaction.reply({
            content: `This server has ${interaction.guild.memberCount.toLocaleString('en-US')} members. A current-member report is capped at ${CURRENT_SCOPE_MEMBER_LIMIT.toLocaleString('en-US')}. Use tracked members only.`,
            ephemeral: true,
        });
        return commandError('Guild too large for current-member report');
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const progressRows = await levelingProgressRepo.getAllByGuildId(interaction.guildId);
        const members = await loadReportMemberSnapshots(
            interaction.guild,
            parsedFilter.filter,
            progressRows
        );

        const report = buildBelowThresholdReport({
            filter: parsedFilter.filter,
            members,
            progressRows,
        });

        const cardPng = await renderBelowThresholdCard({
            guildName: interaction.guild.name,
            report,
        });
        const csv = formatBelowThresholdCsv(report);

        await interaction.editReply({
            content: formatBelowThresholdReply(report),
            files: [
                new AttachmentBuilder(cardPng, { name: 'level-report.png' }),
                new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: 'level-report.csv' }),
            ],
        });

        return commandSuccess();
    } catch (error) {
        console.error('[leveling] Error handling level-report command:', error);

        await interaction.editReply({
            content: 'Something went wrong while generating the leveling report.',
        });

        return commandError(error instanceof Error ? error.message : 'Unknown error');
    }
}

function toMemberSnapshot(member: GuildMember): GuildMemberSnapshot {
    return {
        userId: member.id,
        displayName: member.displayName,
        username: member.user.username,
        isBot: member.user.bot,
        avatarUrl: cardAvatarUrlFromUser(member.user, 128),
    };
}

async function loadReportMemberSnapshots(
    guild: Guild,
    filter: BelowThresholdFilter,
    progressRows: readonly LevelingProgress[]
): Promise<GuildMemberSnapshot[]> {
    if (filter.scope === 'tracked') {
        const candidateIds = progressRows
            .filter((row) => isBelowThreshold(row.level, row.totalXp, filter))
            .map((row) => row.userId);

        return fetchMembersByIds(guild, candidateIds);
    }

    const memberCollection = await guild.members.fetch();
    return memberCollection.map(toMemberSnapshot);
}

async function fetchMembersByIds(guild: Guild, userIds: readonly string[]): Promise<GuildMemberSnapshot[]> {
    if (userIds.length === 0) {
        return [];
    }

    const snapshots: GuildMemberSnapshot[] = [];

    for (let offset = 0; offset < userIds.length; offset += MEMBER_ID_FETCH_BATCH_SIZE) {
        const batch = userIds.slice(offset, offset + MEMBER_ID_FETCH_BATCH_SIZE);
        const fetched = await guild.members.fetch({ user: batch });
        snapshots.push(...fetched.map(toMemberSnapshot));
    }

    return snapshots;
}
