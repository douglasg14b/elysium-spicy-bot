import type { Client, TextChannel } from 'discord.js';
import { aiService } from '../ai-reply/aiService';
import { birthdayRepository } from './data/birthdayRepo';
import { birthdayConfigRepository } from './data/birthdayConfigRepo';
import { resolveBirthdayAnnouncementChannel } from './birthdayChannelResolver';
import { sanitizeBirthdayAnnouncementText } from './birthdayMessageUtils';
import { buildBirthdayFallbackAnnouncement } from './constants';

/** Visible for tests and tuning; production tick is five minutes. */
export const BIRTHDAY_ANNOUNCEMENT_INTERVAL_MS = 5 * 60 * 1000;

const MARK_ANNOUNCED_MAX_ATTEMPTS = 4;
const MARK_ANNOUNCED_BASE_DELAY_MS = 50;

let schedulerStarted = false;
let schedulerIntervalId: ReturnType<typeof setInterval> | undefined;
let announcementTickChain: Promise<void> = Promise.resolve();

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function markAnnouncedWithRetry(guildId: string, userId: string): Promise<void> {
    let lastError: unknown;
    for (let attemptIndex = 0; attemptIndex < MARK_ANNOUNCED_MAX_ATTEMPTS; attemptIndex++) {
        try {
            await birthdayRepository.markAnnounced(guildId, userId);
            return;
        } catch (error) {
            lastError = error;
            if (attemptIndex < MARK_ANNOUNCED_MAX_ATTEMPTS - 1) {
                const backoffMs = MARK_ANNOUNCED_BASE_DELAY_MS * 2 ** attemptIndex;
                await delay(backoffMs);
            }
        }
    }
    throw lastError;
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
 * Runs one announcement pass: due birthdays, per-guild channel, AI + sanitize, send; {@link BirthdayRepository.markAnnounced} only after a successful send so failed sends retry on a later tick.
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
            let body: string;
            try {
                const generated = await aiService.generateBirthdayAnnouncement({
                    displayName,
                    username: row.username,
                });
                body = sanitizeBirthdayAnnouncementText(generated);
                if (!body) {
                    body = buildBirthdayFallbackAnnouncement(displayName);
                }
            } catch (error) {
                console.warn('Birthday AI generation failed, using fallback:', error);
                body = buildBirthdayFallbackAnnouncement(displayName);
            }

            try {
                await channel.send({ content: `${mention}\n${body}` });
                console.info(`Birthday announcement sent for user ${row.userId} in guild ${row.guildId}`);
            } catch (error) {
                console.warn(`Birthday announcement send failed for user ${row.userId} in guild ${row.guildId}:`, error);
                continue;
            }

            try {
                await markAnnouncedWithRetry(row.guildId, row.userId);
            } catch (error) {
                console.error(
                    `Birthday announcement was sent but lastAnnouncedAt could not be persisted after retries for user ${row.userId} in guild ${row.guildId}; the same user may be announced again on a later tick.`,
                    error
                );
            }
        }
    } catch (error) {
        console.error('Birthday announcement tick failed:', error);
    }
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
