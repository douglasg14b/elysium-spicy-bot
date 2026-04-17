import { Client, Guild, GuildBasedChannel, Message, PermissionsBitField } from 'discord.js';
import { aiService, AIService } from '../ai-reply/aiService';
import { BirthdayConfigRepo, birthdayConfigRepo } from './data/birthdayConfigRepo';
import { BirthdayRepository, birthdayRepository, isWithinBirthdayAnnouncementWindow } from './data/birthdayRepo';

const BIRTHDAY_ANNOUNCEMENT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_BIRTHDAY_ANNOUNCEMENT_LENGTH = 500;
const MAX_BIRTHDAY_GENERATION_ATTEMPTS = 3;
const MARK_ANNOUNCED_RETRY_DELAYS_MS = [250, 1000, 3000] as const;
const CONTEXT_FETCH_PAGE_SIZE = 100;
const CONTEXT_FETCH_MAX_PAGES = 3;
const CONTEXT_MESSAGES_TO_FEED = 3;

export type BirthdayAnnouncementDependencies = {
    birthdayRepository: BirthdayRepository;
    birthdayConfigRepo: BirthdayConfigRepo;
    aiService: AIService;
};

const defaultDependencies: BirthdayAnnouncementDependencies = {
    birthdayRepository,
    birthdayConfigRepo,
    aiService,
};

let birthdayAnnouncementInterval: ReturnType<typeof setInterval> | null = null;
let isTickRunning = false;
const contextChannelMessageCache = new Map<string, ContextChannelCacheState>();

type CachedContextMessage = {
    id: string;
    userId: string;
    content: string;
    createdTimestamp: number;
};

type ContextChannelCacheState = {
    messages: Map<string, CachedContextMessage>;
    reachedChannelStart: boolean;
};

export function startBirthdayAnnouncementScheduler(
    client: Client,
    intervalMs: number = BIRTHDAY_ANNOUNCEMENT_INTERVAL_MS,
): void {
    if (birthdayAnnouncementInterval) {
        return;
    }

    birthdayAnnouncementInterval = setInterval(() => {
        void runBirthdayAnnouncementTick(client);
    }, intervalMs);

    console.info(`[birthday-announcements] Scheduler started with interval ${intervalMs}ms`);
}

export function stopBirthdayAnnouncementScheduler(): void {
    if (!birthdayAnnouncementInterval) {
        return;
    }

    clearInterval(birthdayAnnouncementInterval);
    birthdayAnnouncementInterval = null;
    console.info('[birthday-announcements] Scheduler stopped');
}

export async function runBirthdayAnnouncementTick(
    client: Client,
    dependencies: BirthdayAnnouncementDependencies = defaultDependencies,
): Promise<void> {
    if (isTickRunning) {
        console.info('[birthday-announcements] Skipping tick because previous tick is still running');
        return;
    }

    if (!client.user) {
        return;
    }

    isTickRunning = true;

    try {
        const now = new Date();
        if (!isWithinBirthdayAnnouncementWindow(now)) {
            console.info(
                '[birthday-announcements] Skipping tick because it is outside the Pacific announcement window',
            );
            return;
        }

        const birthdaysDueToday = await dependencies.birthdayRepository.findDueForAnnouncementToday(now);

        for (const birthdayRecord of birthdaysDueToday) {
            const resolvedChannel = await resolveBirthdayAnnouncementChannel(
                client,
                birthdayRecord.guildId,
                dependencies.birthdayConfigRepo,
            );

            if (!resolvedChannel) {
                console.warn(
                    `[birthday-announcements] Skipping user ${birthdayRecord.userId} in guild ${birthdayRecord.guildId}: no valid configured channel`,
                );
                continue;
            }

            const member = await resolvedChannel.guild.members.fetch(birthdayRecord.userId).catch(() => null);
            const mention = `<@${birthdayRecord.userId}>`;
            const contextMessages = await getContextMessagesForBirthdayUser(
                resolvedChannel.guild,
                resolvedChannel.config.contextChannelId,
                birthdayRecord.userId,
            );

            const displayName = member?.displayName || birthdayRecord.displayName;
            const username = member?.user.username || birthdayRecord.username;
            let generatedAnnouncement = '';
            try {
                generatedAnnouncement = await generateSafeBirthdayAnnouncement({
                    aiService: dependencies.aiService,
                    displayName,
                    username,
                    contextualMessages: contextMessages,
                });
            } catch (error) {
                console.warn(
                    `[birthday-announcements] AI generation failed for ${birthdayRecord.userId}, using fallback:`,
                    error,
                );
                generatedAnnouncement = getBirthdayFallbackMessage();
            }

            const sendableChannel = resolvedChannel.channel as GuildBasedChannel & {
                send: (options: {
                    content: string;
                    allowedMentions: { parse: string[]; users: string[] };
                }) => Promise<unknown>;
            };

            try {
                await sendableChannel.send({
                    content: `${mention}\n${sanitizeAnnouncementForSend(generatedAnnouncement)}`,
                    allowedMentions: {
                        parse: [],
                        users: [birthdayRecord.userId],
                    },
                });

                await markBirthdayAnnouncedWithRetry(
                    dependencies.birthdayRepository,
                    birthdayRecord.guildId,
                    birthdayRecord.userId,
                );

                console.info(
                    `[birthday-announcements] Sent announcement for user ${birthdayRecord.userId} in guild ${birthdayRecord.guildId}`,
                );
            } catch (error) {
                console.warn(
                    `[birthday-announcements] Failed to send announcement for user ${birthdayRecord.userId} in guild ${birthdayRecord.guildId}:`,
                    error,
                );
            }
        }
    } finally {
        isTickRunning = false;
    }
}

async function resolveBirthdayAnnouncementChannel(
    client: Client,
    guildId: string,
    configRepository: BirthdayConfigRepo,
): Promise<{ guild: Guild; channel: GuildBasedChannel; config: { contextChannelId: string | null } } | null> {
    const config = await configRepository.getByGuildId(guildId);

    if (!config?.announcementChannelId) {
        return null;
    }

    const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
    if (!guild) {
        return null;
    }

    const channel = await guild.channels.fetch(config.announcementChannelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
        return null;
    }

    const botMember = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    if (!botMember) {
        return null;
    }

    const permissions = channel.permissionsFor(botMember);
    if (
        !permissions.has(PermissionsBitField.Flags.ViewChannel) ||
        !permissions.has(PermissionsBitField.Flags.SendMessages)
    ) {
        return null;
    }

    return {
        guild,
        channel,
        config: {
            contextChannelId: config.contextChannelId,
        },
    };
}

function getBirthdayFallbackMessage(): string {
    return 'Happy birthday. Cause a little tasteful chaos today.';
}

async function markBirthdayAnnouncedWithRetry(
    repository: BirthdayRepository,
    guildId: string,
    userId: string,
): Promise<void> {
    for (const [attemptIndex, retryDelay] of MARK_ANNOUNCED_RETRY_DELAYS_MS.entries()) {
        try {
            await repository.markAnnounced(guildId, userId);
            return;
        } catch (error) {
            const attemptNumber = attemptIndex + 1;
            const isFinalAttempt = attemptIndex === MARK_ANNOUNCED_RETRY_DELAYS_MS.length - 1;

            if (isFinalAttempt) {
                throw error;
            }

            console.warn(
                `[birthday-announcements] Failed to persist announcement for user ${userId} in guild ${guildId} (attempt ${attemptNumber}). Retrying in ${retryDelay}ms`,
                error,
            );

            await sleep(retryDelay);
        }
    }
}

function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

export function sanitizeAnnouncementForSend(generatedText: string): string {
    const normalizedText = generatedText
        // Defense-in-depth: even though this is blocked in validation, defang broad mentions at send time.
        .replace(/@everyone/gi, '@\u200beveryone')
        .replace(/@here/gi, '@\u200bhere')
        .trim();

    if (!normalizedText) {
        return getBirthdayFallbackMessage();
    }

    if (normalizedText.length <= MAX_BIRTHDAY_ANNOUNCEMENT_LENGTH) {
        return normalizedText;
    }

    return normalizedText.slice(0, MAX_BIRTHDAY_ANNOUNCEMENT_LENGTH).trimEnd();
}

async function generateSafeBirthdayAnnouncement(input: {
    aiService: AIService;
    displayName: string;
    username: string;
    contextualMessages: string[];
}): Promise<string> {
    let retryFeedback: string | undefined;

    for (let attemptIndex = 0; attemptIndex < MAX_BIRTHDAY_GENERATION_ATTEMPTS; attemptIndex += 1) {
        const generatedText = await input.aiService.generateBirthdayAnnouncement({
            displayName: input.displayName,
            username: input.username,
            contextualMessages: input.contextualMessages,
            retryFeedback,
        });

        const violations = detectAnnouncementViolations(generatedText, {
            forbiddenPhrases: [input.displayName, input.username],
        });

        if (violations.length === 0) {
            return generatedText.trim();
        }

        retryFeedback = `Violations:\n- ${violations.join('\n- ')}\nDo not include any of these in the next attempt.`;
    }

    throw new Error('Birthday announcement generation exceeded retry attempts');
}

export function detectAnnouncementViolations(
    generatedText: string,
    options: { forbiddenPhrases: string[] },
): string[] {
    const violations: string[] = [];
    const normalizedText = generatedText.trim();

    if (!normalizedText) {
        violations.push('output must not be empty');
    }

    if (normalizedText.length > MAX_BIRTHDAY_ANNOUNCEMENT_LENGTH) {
        violations.push(`output exceeds ${MAX_BIRTHDAY_ANNOUNCEMENT_LENGTH} characters`);
    }

    if (/(@everyone|@here)/i.test(normalizedText)) {
        violations.push('output must not include @everyone or @here');
    }

    if (/\b(?:age\s*\d{1,3}|turned\s+\d{1,3}|turning\s+\d{1,3}|\d{1,3}\s*(?:years old|yo|y\/o))\b/i.test(normalizedText)) {
        violations.push('output must not mention age');
    }

    for (const forbiddenPhrase of options.forbiddenPhrases) {
        if (!forbiddenPhrase.trim()) {
            continue;
        }
        const escapedPhrase = escapeForRegex(forbiddenPhrase.trim());
        if (escapedPhrase && new RegExp(escapedPhrase, 'i').test(normalizedText)) {
            violations.push(`output must not include "${forbiddenPhrase}"`);
        }
    }

    return violations;
}

async function getContextMessagesForBirthdayUser(
    guild: Guild,
    contextChannelId: string | null,
    userId: string,
): Promise<string[]> {
    if (!contextChannelId) {
        return [];
    }

    const contextChannel = await guild.channels.fetch(contextChannelId).catch(() => null);
    if (
        !contextChannel ||
        !contextChannel.isTextBased() ||
        contextChannel.isDMBased() ||
        !('messages' in contextChannel)
    ) {
        return [];
    }

    const botMember = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    if (!botMember) {
        return [];
    }

    const contextPermissions = contextChannel.permissionsFor(botMember);
    if (
        !contextPermissions.has(PermissionsBitField.Flags.ViewChannel) ||
        !contextPermissions.has(PermissionsBitField.Flags.ReadMessageHistory)
    ) {
        return [];
    }

    const cacheKey = `${guild.id}:${contextChannel.id}`;
    const cacheState = contextChannelMessageCache.get(cacheKey) ?? {
        messages: new Map<string, CachedContextMessage>(),
        reachedChannelStart: false,
    };
    contextChannelMessageCache.set(cacheKey, cacheState);

    const hadExistingCache = cacheState.messages.size > 0;
    await fetchRecentUntilCacheBoundary(contextChannel, cacheState);

    const cachedUserContextMessages = getTopContextMessagesFromCache(cacheState.messages, userId);
    const needsMoreContextMessages = cachedUserContextMessages.length < CONTEXT_MESSAGES_TO_FEED;

    if (hadExistingCache && needsMoreContextMessages && !cacheState.reachedChannelStart) {
        await fetchOlderFromOldestCache(contextChannel, cacheState, userId);
    }

    return getTopContextMessagesFromCache(cacheState.messages, userId);
}

async function fetchRecentUntilCacheBoundary(
    contextChannel: GuildBasedChannel & { messages: { fetch: (options: { limit: number; before?: string }) => Promise<Map<string, Message>> } },
    cacheState: ContextChannelCacheState,
): Promise<void> {
    let beforeId: string | undefined;

    for (let pageIndex = 0; pageIndex < CONTEXT_FETCH_MAX_PAGES; pageIndex += 1) {
        const fetchedMessages = await contextChannel.messages
            .fetch({
                limit: CONTEXT_FETCH_PAGE_SIZE,
                ...(beforeId ? { before: beforeId } : {}),
            })
            .catch(() => null);

        if (!fetchedMessages || fetchedMessages.size === 0) {
            return;
        }

        let foundCachedBoundary = false;
        const sortedMessages = [...fetchedMessages.values()].sort(
            (firstMessage, secondMessage) => secondMessage.createdTimestamp - firstMessage.createdTimestamp,
        );

        for (const message of sortedMessages) {
            if (cacheState.messages.has(message.id)) {
                foundCachedBoundary = true;
                continue;
            }

            maybeCacheContextMessage(cacheState.messages, message);
        }

        const oldestMessageInPage = sortedMessages[sortedMessages.length - 1];
        beforeId = oldestMessageInPage?.id;

        if (foundCachedBoundary) {
            return;
        }
    }
}

async function fetchOlderFromOldestCache(
    contextChannel: GuildBasedChannel & { messages: { fetch: (options: { limit: number; before?: string }) => Promise<Map<string, Message>> } },
    cacheState: ContextChannelCacheState,
    userId: string,
): Promise<void> {
    let oldestCachedMessageId = getOldestCachedMessageId(cacheState.messages);
    if (!oldestCachedMessageId) {
        return;
    }

    for (let pageIndex = 0; pageIndex < CONTEXT_FETCH_MAX_PAGES; pageIndex += 1) {
        const fetchedMessages = await contextChannel.messages
            .fetch({
                limit: CONTEXT_FETCH_PAGE_SIZE,
                before: oldestCachedMessageId,
            })
            .catch(() => null);

        if (!fetchedMessages || fetchedMessages.size === 0) {
            cacheState.reachedChannelStart = true;
            return;
        }

        for (const message of fetchedMessages.values()) {
            maybeCacheContextMessage(cacheState.messages, message);
        }

        oldestCachedMessageId = getOldestCachedMessageId(cacheState.messages) ?? oldestCachedMessageId;

        const hasEnoughUserContext =
            getTopContextMessagesFromCache(cacheState.messages, userId).length >= CONTEXT_MESSAGES_TO_FEED;
        if (hasEnoughUserContext) {
            return;
        }
    }
}

function maybeCacheContextMessage(cache: Map<string, CachedContextMessage>, message: Message): void {
    if (!message.content.trim()) {
        return;
    }

    cache.set(message.id, {
        id: message.id,
        userId: message.author.id,
        content: message.content.trim(),
        createdTimestamp: message.createdTimestamp,
    });
}

function getOldestCachedMessageId(cache: Map<string, CachedContextMessage>): string | undefined {
    let oldestMessageId: string | undefined;
    let oldestTimestamp = Number.POSITIVE_INFINITY;

    for (const cachedMessage of cache.values()) {
        if (cachedMessage.createdTimestamp < oldestTimestamp) {
            oldestTimestamp = cachedMessage.createdTimestamp;
            oldestMessageId = cachedMessage.id;
        }
    }

    return oldestMessageId;
}

function getTopContextMessagesFromCache(cache: Map<string, CachedContextMessage>, userId: string): string[] {
    const matchingMessages = [...cache.values()]
        .filter((cachedMessage) => cachedMessage.userId === userId)
        .sort((firstMessage, secondMessage) => secondMessage.createdTimestamp - firstMessage.createdTimestamp)
        .slice(0, CONTEXT_MESSAGES_TO_FEED)
        .reverse()
        .map((cachedMessage) => cachedMessage.content);

    return matchingMessages;
}

function escapeForRegex(rawValue: string): string {
    return rawValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
