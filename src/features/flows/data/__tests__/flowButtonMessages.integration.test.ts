import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect, sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { up as createFlowButtonMessages } from '../../../../features-system/data-persistence/migrations/2026-09-20-Create_Flow_Button_Messages';

/**
 * The button-message table against real SQL.
 *
 * Runs the migration's own sqlite arm rather than a hand-written schema, so the table
 * under test is the table that ships — a local `CREATE TABLE` would happily pass while
 * the real migration was wrong. Same reasoning as
 * `resourceBindings.integration.test.ts`, which this follows.
 *
 * What is actually worth asserting here is the *absence* of a unique constraint: one
 * flow legitimately has its buttons in several channels, and that is the whole reason
 * this is a table rather than a column on `flows`.
 */

interface TestDatabase {
    flow_button_messages: {
        id: number;
        guildId: string;
        flowId: string;
        channelId: string;
        messageId: string;
        nodeIds: string;
        createdAt: string;
        updatedAt: string;
    };
}

let db: Kysely<TestDatabase>;

const GUILD = 'guild-1';
const FLOW = 'flow-1';

beforeAll(async () => {
    db = new Kysely<TestDatabase>({
        // CamelCasePlugin only. Where both are used it must come first, or
        // SqlDatePlugin never matches its camelCase keys.
        dialect: new SqliteDialect({ database: new SqliteDatabase(':memory:') }),
        plugins: [new CamelCasePlugin()],
    });

    process.env.DB_TYPE = 'sqlite';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createFlowButtonMessages(db as unknown as Kysely<any>);
});

afterAll(async () => {
    await db.destroy();
});

beforeEach(async () => {
    await db.deleteFrom('flow_button_messages').execute();
});

async function insertMessage(overrides: Record<string, unknown> = {}) {
    const now = new Date().toISOString();
    await db
        .insertInto('flow_button_messages')
        .values({
            guildId: GUILD,
            flowId: FLOW,
            channelId: 'channel-1',
            messageId: 'message-1',
            nodeIds: JSON.stringify(['node-1']),
            createdAt: now,
            updatedAt: now,
            ...overrides,
        } as never)
        .execute();
}

describe('the flow button message table', () => {
    it('stores a posted message and reads it back', async () => {
        await insertMessage();

        const rows = await db.selectFrom('flow_button_messages').selectAll().execute();

        expect(rows).toHaveLength(1);
        expect(rows[0].messageId).toBe('message-1');
        expect(JSON.parse(rows[0].nodeIds)).toEqual(['node-1']);
    });

    it('lets one flow have buttons in several channels', async () => {
        // The reason this is a table and not a column. A unique constraint on the flow
        // would silently keep only the last deploy and orphan every earlier one.
        await insertMessage({ channelId: 'channel-1', messageId: 'message-1' });
        await insertMessage({ channelId: 'channel-2', messageId: 'message-2' });

        const rows = await db
            .selectFrom('flow_button_messages')
            .selectAll()
            .where('flowId', '=', FLOW)
            .execute();

        expect(rows).toHaveLength(2);
    });

    it('keeps rows for a flow that no longer exists', async () => {
        // There is no foreign key on purpose: a row outliving its flow is the useful
        // state, and it is what lets an orphaned button still be found and retired.
        await insertMessage({ flowId: 'flow-deleted-long-ago' });

        const rows = await db
            .selectFrom('flow_button_messages')
            .selectAll()
            .where('flowId', '=', 'flow-deleted-long-ago')
            .execute();

        expect(rows).toHaveLength(1);
    });

    it('defaults timestamps to ISO-8601 with an explicit Z', async () => {
        // Not `CURRENT_TIMESTAMP`, which yields a zoneless space-separated string that
        // V8 parses as *local* time — invisible on a UTC host, wrong everywhere else.
        await db
            .insertInto('flow_button_messages')
            .values({
                guildId: GUILD,
                flowId: FLOW,
                channelId: 'channel-1',
                messageId: 'message-defaulted',
                nodeIds: JSON.stringify([]),
            } as never)
            .execute();

        const row = await db
            .selectFrom('flow_button_messages')
            .selectAll()
            .where('messageId', '=', 'message-defaulted')
            .executeTakeFirstOrThrow();

        expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('indexes the guild and flow lookup', async () => {
        await insertMessage();

        const plan = await sql<{ detail: string }>`
            EXPLAIN QUERY PLAN
            SELECT * FROM flow_button_messages WHERE guild_id = ${GUILD} AND flow_id = ${FLOW}
        `.execute(db);

        expect(plan.rows.map((entry) => entry.detail).join(' ')).toContain(
            'flow_button_messages_guild_flow_idx'
        );
    });
});
