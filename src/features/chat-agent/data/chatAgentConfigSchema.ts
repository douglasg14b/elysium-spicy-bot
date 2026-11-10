import type { ColumnType, Generated, JSONColumnType, Selectable } from 'kysely';
import { z } from 'zod';

/** How many context channels a server may configure. */
export const MAX_CONTEXT_CHANNELS = 10;

/** How long each of the admins' hand-written texts may be. Both go into every turn's instructions, so they cost tokens on every reply. */
export const MAX_GUIDANCE_LENGTH = 2_000;

export const CHAT_AGENT_CONFIG_VERSION = 1;

/** A channel the chat agent may read for context; `isRules` ones feed `getServerRules`. */
export type ContextChannel = {
    readonly channelId: string;
    readonly isRules: boolean;
};

/** What `chat_agent_config.config` holds. */
export type ChatAgentConfig = {
    readonly contextChannels: readonly ContextChannel[];
    /** Facts about the server, in the admins' words, that the agent may repeat to anyone. Empty when none. */
    readonly serverNotes: string;
    /** How the agent should behave on this server, in the admins' words. Empty when none. */
    readonly botRules: string;
};

/** A server with nothing configured. */
export const EMPTY_CHAT_AGENT_CONFIG: ChatAgentConfig = { contextChannels: [], serverNotes: '', botRules: '' };

/** The first channel id listed twice, if any. A channel is on the list once. */
export function duplicateContextChannelId(contextChannels: readonly ContextChannel[]): string | undefined {
    const seen = new Set<string>();
    for (const { channelId } of contextChannels) {
        if (seen.has(channelId)) return channelId;
        seen.add(channelId);
    }
    return undefined;
}

/** The stored config's rules: at most {@link MAX_CONTEXT_CHANNELS} channels, each once; texts trimmed, at most {@link MAX_GUIDANCE_LENGTH}. The repo writes nothing else. */
export const chatAgentConfigSchema = z.object({
    contextChannels: z
        .array(z.object({ channelId: z.string().min(1), isRules: z.boolean() }))
        .max(MAX_CONTEXT_CHANNELS)
        .superRefine((contextChannels, refinement) => {
            const duplicate = duplicateContextChannelId(contextChannels);
            if (duplicate) refinement.addIssue({ code: 'custom', message: `Channel ${duplicate} is listed twice` });
        }),
    serverNotes: z.string().trim().max(MAX_GUIDANCE_LENGTH),
    botRules: z.string().trim().max(MAX_GUIDANCE_LENGTH),
});

/**
 * One row per guild. `config` is JSON — read whole and written whole, like
 * `ticketing_config.config` — so sqlite needs `SqliteJsonPlugin` to parse it back
 * (registered in `database.ts`); postgres returns it parsed.
 */
export interface ChatAgentConfigTable {
    id: Generated<number>;
    guildId: string;
    config: JSONColumnType<ChatAgentConfig>;
    createdAt: ColumnType<Date, string, string>;
    updatedAt: ColumnType<Date, string, string>;
    configVersion: number;
}

export type ChatAgentConfigRow = Selectable<ChatAgentConfigTable>;
