import type { Message, PartialMessage, User } from 'discord.js';

export function isEligibleMessageAuthor(user: User): boolean {
    return !user.bot;
}

export function isGuildMessage(message: Message | PartialMessage): message is Message {
    return !!message.guildId && !!message.guild;
}

export function isSlashCommandMessage(message: Message): boolean {
    return message.content.startsWith('/');
}

export function getMessageXpSkipReason(message: Message): string | null {
    if (message.system) {
        return 'system message';
    }

    if (!isGuildMessage(message)) {
        return 'not a guild message';
    }

    if (!isEligibleMessageAuthor(message.author)) {
        return 'bot author';
    }

    if (isSlashCommandMessage(message)) {
        return 'slash command message';
    }

    return null;
}

export function shouldSkipMessageForXp(message: Message): boolean {
    return getMessageXpSkipReason(message) !== null;
}

export function shouldSkipReactionUser(user: Pick<User, 'bot'>): boolean {
    return !isEligibleMessageAuthor(user as User);
}

export function isCooldownActive(
    lastActivityAt: Date | null | undefined,
    cooldownMs: number,
    now: Date = new Date()
): boolean {
    if (!lastActivityAt) {
        return false;
    }

    return now.getTime() - lastActivityAt.getTime() < cooldownMs;
}

export function toActivityDate(value: Date | string | null | undefined): Date | null {
    if (!value) {
        return null;
    }

    return value instanceof Date ? value : new Date(value);
}
