import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../../../features-system/data-persistence/database';
import { up as createChatAgentConfig } from '../../../../features-system/data-persistence/migrations/2026-11-06-Create_Chat_Agent_Config';
import { SqliteJsonPlugin } from '../../../../features-system/data-persistence/plugins/sqliteJsonPlugin';
import { ChatAgentConfigRepo } from '../chatAgentConfigRepo';
import { EMPTY_CHAT_AGENT_CONFIG, MAX_CONTEXT_CHANNELS, MAX_GUIDANCE_LENGTH } from '../chatAgentConfigSchema';

/**
 * The chat agent config repo against real SQL, on the migration's own sqlite arm: whether the
 * config survives the JSON column, booleans included, and whether the unique index keeps one row
 * per guild across writes.
 */

let db: Kysely<any>;
let repo: ChatAgentConfigRepo;

const GUILD = 'guild-1';
const RULES = { channelId: '100000000000000001', isRules: true };
const KINK_101 = { channelId: '100000000000000002', isRules: false };

beforeAll(async () => {
    db = new Kysely<any>({
        dialect: new SqliteDialect({ database: new SqliteDatabase(':memory:') }),
        // Mirrors the production client for this table, in the same relative order.
        plugins: [new SqliteJsonPlugin<any>({ chat_agent_config: ['config'] }), new CamelCasePlugin()],
    });
    process.env.DB_TYPE = 'sqlite';
    await createChatAgentConfig(db);
    repo = new ChatAgentConfigRepo(db as unknown as DatabaseClient);
});

afterAll(async () => {
    await db.destroy();
});

beforeEach(async () => {
    await db.deleteFrom('chat_agent_config').execute();
});

describe('ChatAgentConfigRepo', () => {
    it('reads a guild with no row as nothing configured', async () => {
        expect(await repo.getConfig(GUILD)).toEqual(EMPTY_CHAT_AGENT_CONFIG);
    });

    it('round-trips the config through the JSON column, channels in order, booleans intact', async () => {
        const config = { contextChannels: [KINK_101, RULES], serverNotes: 'Munches are the first Saturday.', botRules: 'Never recommend other servers.' };
        expect(await repo.saveConfig(GUILD, config)).toEqual(config);
        expect(await repo.getConfig(GUILD)).toEqual(config);
        expect(await repo.getConfig('guild-2')).toEqual(EMPTY_CHAT_AGENT_CONFIG);
    });

    it('stores the texts trimmed', async () => {
        const saved = await repo.saveConfig(GUILD, { ...EMPTY_CHAT_AGENT_CONFIG, serverNotes: '  Munches monthly.\n', botRules: '\n ' });
        expect(saved).toMatchObject({ serverNotes: 'Munches monthly.', botRules: '' });
    });

    it('replaces the config on a second write, keeping one row per guild', async () => {
        await repo.saveConfig(GUILD, { contextChannels: [RULES, KINK_101], serverNotes: 'Old notes.', botRules: 'Old rules.' });
        await repo.saveConfig(GUILD, { ...EMPTY_CHAT_AGENT_CONFIG, contextChannels: [RULES] });
        expect(await repo.getConfig(GUILD)).toEqual({ ...EMPTY_CHAT_AGENT_CONFIG, contextChannels: [RULES] });
        await repo.saveConfig(GUILD, EMPTY_CHAT_AGENT_CONFIG);
        expect(await repo.getConfig(GUILD)).toEqual(EMPTY_CHAT_AGENT_CONFIG);
        expect(await db.selectFrom('chat_agent_config').selectAll().execute()).toHaveLength(1);
    });

    it('refuses a channel listed twice, storing nothing', async () => {
        await expect(
            repo.saveConfig(GUILD, { ...EMPTY_CHAT_AGENT_CONFIG, contextChannels: [RULES, { ...RULES, isRules: false }] })
        ).rejects.toThrow();
        expect(await repo.getConfig(GUILD)).toEqual(EMPTY_CHAT_AGENT_CONFIG);
    });

    it(`refuses more than ${MAX_CONTEXT_CHANNELS} channels`, async () => {
        const tooMany = Array.from({ length: MAX_CONTEXT_CHANNELS + 1 }, (_unused, index) => ({
            channelId: `1000000000000001${String(index).padStart(2, '0')}`,
            isRules: false,
        }));
        await expect(repo.saveConfig(GUILD, { ...EMPTY_CHAT_AGENT_CONFIG, contextChannels: tooMany })).rejects.toThrow();
        await repo.saveConfig(GUILD, { ...EMPTY_CHAT_AGENT_CONFIG, contextChannels: tooMany.slice(0, MAX_CONTEXT_CHANNELS) });
        expect((await repo.getConfig(GUILD)).contextChannels).toHaveLength(MAX_CONTEXT_CHANNELS);
    });

    it(`refuses a text over ${MAX_GUIDANCE_LENGTH} characters, storing nothing`, async () => {
        await expect(repo.saveConfig(GUILD, { ...EMPTY_CHAT_AGENT_CONFIG, botRules: 'x'.repeat(MAX_GUIDANCE_LENGTH + 1) })).rejects.toThrow();
        expect(await repo.getConfig(GUILD)).toEqual(EMPTY_CHAT_AGENT_CONFIG);
    });
});
