import { EmbedBuilder, type Guild } from 'discord.js';
import { warningsConfigRepo, type WarningsConfigRepo } from '../data/warningsConfigRepo';
import { warningsRepo, type WarningsRepo } from '../data/warningsRepo';
import type { Warning } from '../data/warningsSchema';
import { calendarDateFromUtcMidnight, formatCalendarDate, getActiveAsOfUtcMidnight } from './warningDates';
import { resolveWarningsModChannel } from './warningModChannel';

const EMBED_FIELD_VALUE_MAX = 1024;
const NOTICE_COLOR = 0xe84393;

export type WarningIssuedNoticeStatus = 'sent' | 'unconfigured' | 'skipped' | 'failed';

export type NotifyWarningIssuedDependencies = {
    configRepo?: Pick<WarningsConfigRepo, 'getByGuildId'>;
    warningsRepo?: Pick<WarningsRepo, 'countActive'>;
};

export function buildWarningIssuedNoticeEmbed(input: {
    warning: Warning;
    activeCount: number;
}): EmbedBuilder {
    const issuedLabel = formatCalendarDate(calendarDateFromUtcMidnight(input.warning.issuedAt));
    const expiresLabel = formatCalendarDate(calendarDateFromUtcMidnight(input.warning.expiresAt));

    return new EmbedBuilder()
        .setColor(NOTICE_COLOR)
        .setTitle('Warning issued')
        .addFields(
            { name: 'Member', value: `<@${input.warning.userId}>`, inline: true },
            { name: 'By', value: `<@${input.warning.issuerId}>`, inline: true },
            { name: 'Active on them', value: String(input.activeCount), inline: true },
            { name: 'Rule', value: truncateField(input.warning.rule), inline: false },
            { name: 'Description', value: truncateField(input.warning.description), inline: false },
            { name: 'Slug', value: `\`${input.warning.slug}\``, inline: true },
            { name: 'Issued', value: issuedLabel, inline: true },
            { name: 'Drop-off', value: expiresLabel, inline: true }
        )
        .setTimestamp()
        .setFooter({ text: 'Staff warnings' });
}

export function formatWarnSuccessMessage(
    userId: string,
    slug: string,
    expiresLabel: string,
    noticeStatus: WarningIssuedNoticeStatus
): string {
    const saved = `Warned <@${userId}>. Slug \`${slug}\` — they can stew until ${expiresLabel}.`;

    if (noticeStatus === 'unconfigured') {
        return `${saved}\nNo mod channel is configured, so this stayed in /warn. Set one with /warnings-config.`;
    }

    if (noticeStatus === 'skipped') {
        return `${saved}\nWarning is saved, but I cannot reach the configured mod channel. Check bot perms or /warnings-config.`;
    }

    if (noticeStatus === 'failed') {
        return `${saved}\nWarning is saved, but posting to the mod channel blew up.`;
    }

    return saved;
}

export async function notifyWarningIssued(
    guild: Guild,
    warning: Warning,
    now: Date = new Date(),
    dependencies: NotifyWarningIssuedDependencies = {}
): Promise<WarningIssuedNoticeStatus> {
    try {
        const configRepo = dependencies.configRepo ?? warningsConfigRepo;
        const warningRecords = dependencies.warningsRepo ?? warningsRepo;

        const config = await configRepo.getByGuildId(guild.id);
        if (!config?.modChannelId) {
            return 'unconfigured';
        }

        const channel = await resolveWarningsModChannel(guild, config.modChannelId);
        if (!channel) {
            console.warn(
                `[warnings] Skipping issue notice for guild ${guild.id}: mod channel ${config.modChannelId} unavailable`
            );
            return 'skipped';
        }

        const asOf = getActiveAsOfUtcMidnight(now);
        const activeCount = await warningRecords.countActive(guild.id, asOf, warning.userId);

        await channel.send({
            embeds: [buildWarningIssuedNoticeEmbed({ warning, activeCount })],
            allowedMentions: { parse: [] },
        });
        return 'sent';
    } catch (error) {
        console.error(`[warnings] Failed to post issue notice in guild ${guild.id}:`, error);
        return 'failed';
    }
}

function truncateField(value: string): string {
    if (value.length <= EMBED_FIELD_VALUE_MAX) {
        return value;
    }

    return `${value.slice(0, EMBED_FIELD_VALUE_MAX - 1)}…`;
}
