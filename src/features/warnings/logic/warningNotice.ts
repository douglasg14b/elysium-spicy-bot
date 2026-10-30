import { EmbedBuilder, type Guild } from 'discord.js';
import { warningsConfigRepo, type WarningsConfigRepo } from '../data/warningsConfigRepo';
import { resolveWarningsModChannel } from './warningModChannel';

/**
 * Posting a warning's mod-log notice — issued, released or edited — and what came of it.
 * Discord and the dashboard both post through here, so the channel reads the same
 * whichever surface acted.
 */

/** Discord's cap on one embed field's value. */
export const EMBED_FIELD_VALUE_MAX = 1024;
const NOTICE_COLOR = 0xe84393;
const NOTICE_FOOTER = 'Staff warnings';

/** Every outcome of posting a notice. The warning is saved in all four; only the post differs. */
export const WARNING_NOTICE_STATUSES = ['sent', 'unconfigured', 'skipped', 'failed'] as const;

/**
 * - `sent` — posted in the mod channel.
 * - `unconfigured` — the server has no mod channel set.
 * - `skipped` — the configured channel is gone, or the bot cannot post in it.
 * - `failed` — building or sending the post threw.
 */
export type WarningNoticeStatus = (typeof WARNING_NOTICE_STATUSES)[number];

export type PostWarningNoticeDependencies = {
    configRepo?: Pick<WarningsConfigRepo, 'getByGuildId'>;
};

/** A notice embed with the shared colour, footer and timestamp. */
export function warningNoticeEmbed(title: string): EmbedBuilder {
    return new EmbedBuilder().setColor(NOTICE_COLOR).setTitle(title).setTimestamp().setFooter({ text: NOTICE_FOOTER });
}

/** `value` cut to fit `max` characters, marked with an ellipsis when it was cut. */
export function truncateField(value: string, max: number = EMBED_FIELD_VALUE_MAX): string {
    if (value.length <= max) {
        return value;
    }

    return `${value.slice(0, max - 1)}…`;
}

/**
 * Post an embed in the guild's warnings mod channel, mentioning nobody. Never throws.
 *
 * `buildEmbed` runs only once the channel is found, so a notice that needs a read of its
 * own (the issued notice's active count) costs nothing on a server with no mod channel,
 * and a failure in that read reports as `failed` rather than masking `unconfigured`.
 */
export async function postWarningNotice(
    guild: Guild,
    buildEmbed: () => EmbedBuilder | Promise<EmbedBuilder>,
    dependencies: PostWarningNoticeDependencies = {}
): Promise<WarningNoticeStatus> {
    try {
        const configRepo = dependencies.configRepo ?? warningsConfigRepo;

        const config = await configRepo.getByGuildId(guild.id);
        if (!config?.modChannelId) {
            return 'unconfigured';
        }

        const channel = await resolveWarningsModChannel(guild, config.modChannelId);
        if (!channel) {
            console.warn(
                `[warnings] Skipping notice for guild ${guild.id}: mod channel ${config.modChannelId} unavailable`
            );
            return 'skipped';
        }

        await channel.send({
            embeds: [await buildEmbed()],
            allowedMentions: { parse: [] },
        });
        return 'sent';
    } catch (error) {
        console.error(`[warnings] Failed to post notice in guild ${guild.id}:`, error);
        return 'failed';
    }
}

/** How a Discord command names what it saved, for {@link warningNoticeNote}. */
export type WarningNoticeNoteSurface = {
    /** The slash command, without its slash. */
    readonly command: string;
    /** What was saved, as the start of a sentence: `Warning`, `Release`. */
    readonly saved: string;
};

/**
 * The line a Discord command adds to its reply when the notice did not go out, or `null`
 * when it did. The dashboard words this itself from the `notice` status.
 */
export function warningNoticeNote(status: WarningNoticeStatus, surface: WarningNoticeNoteSurface): string | null {
    switch (status) {
        case 'sent':
            return null;
        case 'unconfigured':
            return `No mod channel is configured, so this stayed in /${surface.command}. Set one with /warnings-config.`;
        case 'skipped':
            return `${surface.saved} is saved, but I cannot reach the configured mod channel. Check bot perms or /warnings-config.`;
        case 'failed':
            return `${surface.saved} is saved, but posting to the mod channel blew up.`;
    }
}
