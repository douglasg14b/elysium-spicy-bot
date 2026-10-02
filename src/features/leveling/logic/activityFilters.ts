import type { Message } from 'discord.js';

/**
 * Leveling's one message rule of its own: a `/`-prefixed message earns no XP.
 *
 * Guild, system-message and bot/webhook exclusions belong to the activity recorder, which
 * never notifies leveling about such messages. A `/`-prefixed message *is* recorded as
 * activity — it only earns nothing here.
 */
export function isSlashCommandMessage(message: Message): boolean {
    return message.content.startsWith('/');
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
