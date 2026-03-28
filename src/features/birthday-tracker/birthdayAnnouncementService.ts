import type { Client, TextChannel } from 'discord.js';
import { aiService } from '../ai-reply/aiService';
import { birthdayRepository } from './data/birthdayRepo';
import { birthdayConfigRepository } from './data/birthdayConfigRepo';
import { resolveBirthdayAnnouncementChannel } from './birthdayChannelResolver';
import { finalizeBirthdayAnnouncementBody } from './birthdayMessageUtils';
import { buildBirthdayFallbackAnnouncement } from './constants';

/** Visible for tests and tuning; production tick is five minutes. */
export const BIRTHDAY_ANNOUNCEMENT_INTERVAL_MS = 5 * 60 * 1000;

let schedulerStarted = false;
let schedulerIntervalId: ReturnType<typeof setInterval> | undefined;
let announcementTickChain: Promise<void> = Promise.resolve();

/**
 * Runs one announcement pass: due birthdays, per-guild channel, AI + outbound finalize, send.
 * Uses {@link BirthdayRepository.claimAnnouncementIfDue} before {@link TextChannel.send} so only one
 * writer (across processes) holds the slot for that local celebration day; if send fails,
 * {@link BirthdayRepository.revertAnnouncementClaim} restores the prior `last_announced_at` so a later tick retries.
 */
export async function executeBirthdayAnnouncementTick(client: Client): Promise<void> {
    if (!client.user) {
        return;
    }

    try {
        const due = await birthdayRepository.findDueForAnnouncementToday();
        const channelByGuild = new Map<string, TextChannel | null>();

        for (const row of due) {
            let channel = channelByGuild.get(row.guildId);
            if (channel === undefined) {
                const configRow = await birthdayConfigRepository.getByGuildId(row.guildId);
                if (!configRow?.announcementChannelId) {
                    console.warn(`Birthday announcement skipped: guild ${row.guildId} has no announcement channel configured`);
                    channelByGuild.set(row.guildId, null);
                    channel = null;
                } else {
                    const resolved = await resolveBirthdayAnnouncementChannel(
                        client,
                        row.guildId,
                        configRow.announcementChannelId
                    );
                    if (!resolved) {
                        console.warn(
                            `Birthday announcement skipped: guild ${row.guildId} announcement channel missing or bot lacks ViewChannel/SendMessages`
                        );
                        channelByGuild.set(row.guildId, null);
                        channel = null;
                    } else {
                        channelByGuild.set(row.guildId, resolved);
                        channel = resolved;
                    }
                }
            }

            if (!channel) {
                continue;
            }

            let displayName = row.displayName;
            try {
                const guild = await client.guilds.fetch(row.guildId);
                const member = await guild.members.fetch(row.userId);
                displayName = member.displayName || member.user.username;
            } catch {
                // Still announce with stored display name + mention
            }

            const mention = `<@${row.userId}>`;
            let rawBody: string;
            try {
                rawBody = await aiService.generateBirthdayAnnouncement({
                    displayName,
                    username: row.username,
                });
            } catch (error) {
                console.warn('Birthday AI generation failed, using fallback:', error);
                rawBody = buildBirthdayFallbackAnnouncement(displayName);
            }

            let body = finalizeBirthdayAnnouncementBody(rawBody);
            if (!body) {
                body = finalizeBirthdayAnnouncementBody(buildBirthdayFallbackAnnouncement(displayName));
            }

            const claim = await birthdayRepository.claimAnnouncementIfDue(row.guildId, row.userId);
            if (!claim.claimed) {
                continue;
            }

            try {
                await channel.send({ content: `${mention}\n${body}` });
                console.info(`Birthday announcement sent for user ${row.userId} in guild ${row.guildId}`);
            } catch (error) {
                console.warn(`Birthday announcement send failed for user ${row.userId} in guild ${row.guildId}:`, error);
                await birthdayRepository.revertAnnouncementClaim(
                    row.guildId,
                    row.userId,
                    claim.claimAt,
                    claim.previousLastAnnouncedAt
                );
            }
        }
    } catch (error) {
        console.error('Birthday announcement tick failed:', error);
    }
}

export function stopBirthdayAnnouncementScheduler(): void {
    if (schedulerIntervalId !== undefined) {
        clearInterval(schedulerIntervalId);
        schedulerIntervalId = undefined;
    }
    schedulerStarted = false;
    announcementTickChain = Promise.resolve();
}

/**
 * Queues a tick after any prior tick completes so interval callbacks cannot overlap.
 */
export function enqueueBirthdayAnnouncementTick(client: Client): void {
    announcementTickChain = announcementTickChain
        .then(() => executeBirthdayAnnouncementTick(client))
        .catch((error) => {
            console.error('Birthday announcement tick failed:', error);
        });
}

/**
 * Idempotent: starts a single interval for the process and runs one tick immediately.
 */
export function startBirthdayAnnouncementScheduler(client: Client): void {
    if (schedulerStarted) {
        return;
    }
    schedulerStarted = true;
    console.info(
        `Birthday announcement scheduler started (${BIRTHDAY_ANNOUNCEMENT_INTERVAL_MS / 60000} minute interval)`
    );
    enqueueBirthdayAnnouncementTick(client);
    schedulerIntervalId = setInterval(() => {
        enqueueBirthdayAnnouncementTick(client);
    }, BIRTHDAY_ANNOUNCEMENT_INTERVAL_MS);
}
