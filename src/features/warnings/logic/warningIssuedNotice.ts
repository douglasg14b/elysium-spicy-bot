import type { EmbedBuilder, Guild } from 'discord.js';
import { warningsRepo, type WarningsRepo } from '../data/warningsRepo';
import type { Warning } from '../data/warningsSchema';
import { calendarDateFromUtcMidnight, formatCalendarDate, getActiveAsOfUtcMidnight } from './warningDates';
import {
    postWarningNotice,
    truncateField,
    warningNoticeEmbed,
    warningNoticeNote,
    type PostWarningNoticeDependencies,
    type WarningNoticeStatus,
} from './warningNotice';

export type NotifyWarningIssuedDependencies = PostWarningNoticeDependencies & {
    warningsRepo?: Pick<WarningsRepo, 'countActive'>;
};

/** The mod-log embed for a warning just issued, with how many are now active on that member. */
export function buildWarningIssuedNoticeEmbed(input: {
    warning: Warning;
    activeCount: number;
}): EmbedBuilder {
    const issuedLabel = formatCalendarDate(calendarDateFromUtcMidnight(input.warning.issuedAt));
    const expiresLabel = formatCalendarDate(calendarDateFromUtcMidnight(input.warning.expiresAt));

    return warningNoticeEmbed('Warning issued').addFields(
        { name: 'Member', value: `<@${input.warning.userId}>`, inline: true },
        { name: 'By', value: `<@${input.warning.issuerId}>`, inline: true },
        { name: 'Active on them', value: String(input.activeCount), inline: true },
        { name: 'Rule', value: truncateField(input.warning.rule), inline: false },
        { name: 'Description', value: truncateField(input.warning.description), inline: false },
        { name: 'Slug', value: `\`${input.warning.slug}\``, inline: true },
        { name: 'Issued', value: issuedLabel, inline: true },
        { name: 'Drop-off', value: expiresLabel, inline: true }
    );
}

export function formatWarnSuccessMessage(
    userId: string,
    slug: string,
    expiresLabel: string,
    noticeStatus: WarningNoticeStatus
): string {
    const saved = `Warned <@${userId}>. Slug \`${slug}\` — they can stew until ${expiresLabel}.`;
    const note = warningNoticeNote(noticeStatus, { command: 'warn', saved: 'Warning' });

    return note ? `${saved}\n${note}` : saved;
}

export async function notifyWarningIssued(
    guild: Guild,
    warning: Warning,
    now: Date = new Date(),
    dependencies: NotifyWarningIssuedDependencies = {}
): Promise<WarningNoticeStatus> {
    const warningRecords = dependencies.warningsRepo ?? warningsRepo;

    return postWarningNotice(
        guild,
        async () =>
            buildWarningIssuedNoticeEmbed({
                warning,
                activeCount: await warningRecords.countActive(guild.id, getActiveAsOfUtcMidnight(now), warning.userId),
            }),
        dependencies
    );
}
