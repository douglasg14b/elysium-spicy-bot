import { database, type DatabaseClient } from '../../../features-system/data-persistence/database';
import {
    CHAT_AGENT_CONFIG_VERSION,
    EMPTY_CHAT_AGENT_CONFIG,
    chatAgentConfigSchema,
    type ChatAgentConfig,
} from './chatAgentConfigSchema';

/** Persistence for a guild's chat agent config. SQL lives here and nowhere else. */
export class ChatAgentConfigRepo {
    constructor(private readonly db: DatabaseClient = database) {}

    /**
     * This guild's config, context channels in saved order; {@link EMPTY_CHAT_AGENT_CONFIG} when
     * nothing is configured. Read through the schema, so a field added since the row was written
     * comes back as its default rather than missing.
     */
    async getConfig(guildId: string): Promise<ChatAgentConfig> {
        const row = await this.db
            .selectFrom('chat_agent_config')
            .select('config')
            .where('guildId', '=', guildId)
            .executeTakeFirst();
        return row ? chatAgentConfigSchema.parse(row.config) : EMPTY_CHAT_AGENT_CONFIG;
    }

    /**
     * Replace this guild's config whole, creating its row if needed. The texts are stored
     * trimmed. Throws on a list over `MAX_CONTEXT_CHANNELS`, a channel listed twice, a text
     * over `MAX_GUIDANCE_LENGTH` or a staff role listed twice — the route refuses those first;
     * this is the last word. Whether each channel and role exists is the route's question.
     */
    async saveConfig(guildId: string, config: ChatAgentConfig): Promise<ChatAgentConfig> {
        const parsed = chatAgentConfigSchema.parse(config);
        // Serialised here: the sqlite JSON plugin only parses on the way out.
        const serialised = JSON.stringify(parsed);
        const now = new Date().toISOString();

        await this.db
            .insertInto('chat_agent_config')
            .values({
                guildId,
                config: serialised,
                createdAt: now,
                updatedAt: now,
                configVersion: CHAT_AGENT_CONFIG_VERSION,
            })
            .onConflict((conflict) => conflict.column('guildId').doUpdateSet({ config: serialised, updatedAt: now }))
            .execute();

        return this.getConfig(guildId);
    }
}

export const chatAgentConfigRepo = new ChatAgentConfigRepo();
