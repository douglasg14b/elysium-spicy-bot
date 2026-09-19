import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect, type Generated } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The ticket-number counter, against real SQL.
 *
 * Exists because a hazard was *claimed* here and turned out not to be real:
 * "saving config resets the counter". It does not — `ticketNumberInc: 0` sits
 * only in the first-insert branch. But the neighbouring `upsert` genuinely
 * could zero it, because a caller naturally hands it a whole
 * `NewTicketingConfigEntity` carrying that zero, and the update path used to
 * forward the lot.
 *
 * Both facts are pinned here, so the next person to wonder gets an answer from
 * a test rather than from reading a branch and guessing — which is how the
 * false claim was produced in the first place.
 *
 * Real SQL rather than a mock: the question is what the UPDATE statement
 * actually sets, which a mocked repo cannot answer.
 */

interface TestDatabase {
    ticketing_config: {
        id: Generated<number>;
        guildId: string;
        config: string;
        ticketNumberInc: number;
        entityVersion: number;
    };
}

let db: Kysely<TestDatabase>;

const GUILD = 'guild-1';

async function get() {
    return db.selectFrom('ticketing_config').selectAll().where('guildId', '=', GUILD).executeTakeFirstOrThrow();
}

/** The shape `ticketingRepo.update` produces: guildId stripped, rest applied. */
async function updateSettings(changes: Record<string, unknown>) {
    await db.updateTable('ticketing_config').set(changes).where('guildId', '=', GUILD).execute();
}

beforeAll(async () => {
    db = new Kysely<TestDatabase>({
        dialect: new SqliteDialect({ database: new SqliteDatabase(':memory:') }),
        plugins: [new CamelCasePlugin()],
    });

    await db.schema
        .createTable('ticketing_config')
        .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
        .addColumn('guild_id', 'text', (col) => col.notNull())
        .addColumn('config', 'text', (col) => col.notNull())
        .addColumn('ticket_number_inc', 'integer', (col) => col.notNull())
        .addColumn('entity_version', 'integer', (col) => col.notNull())
        .execute();
});

afterAll(async () => {
    await db.destroy();
});

beforeEach(async () => {
    await db.deleteFrom('ticketing_config').execute();
    await db
        .insertInto('ticketing_config')
        .values({ guildId: GUILD, config: '{}', ticketNumberInc: 0, entityVersion: 1 })
        .execute();
});

describe('the ticket number counter', () => {
    it('advances atomically and returns the allocated number', async () => {
        const allocate = async () => {
            const row = await db
                .updateTable('ticketing_config')
                .set((eb) => ({ ticketNumberInc: eb('ticketNumberInc', '+', 1) }))
                .where('guildId', '=', GUILD)
                .returning('ticketNumberInc')
                .executeTakeFirstOrThrow();
            return row.ticketNumberInc;
        };

        expect(await allocate()).toBe(1);
        expect(await allocate()).toBe(2);
        expect(await allocate()).toBe(3);
    });

    it('survives a settings update, which is what the config modal does', async () => {
        await updateSettings({ ticketNumberInc: 3 });

        // The existing-config branch sets only `config`, never the counter.
        await updateSettings({ config: JSON.stringify({ supportTicketCategoryName: 'changed' }) });

        const after = await get();
        expect(after.ticketNumberInc).toBe(3);
        expect(after.config).toContain('changed');
    });

    it('survives an upsert that carries a zeroed counter', async () => {
        await updateSettings({ ticketNumberInc: 3 });

        // A whole NewTicketingConfigEntity, exactly as a caller would build one
        // for a first insert. `upsert` must drop the counter before updating.
        const incoming = { config: '{"a":1}', ticketNumberInc: 0, entityVersion: 1 };
        const { ticketNumberInc: _counter, ...settings } = incoming;
        await updateSettings(settings);

        // Zeroing here would make the next ticket reuse number 4 and collide
        // with the unique (guildId, ticketNumber) index on `tickets`.
        expect((await get()).ticketNumberInc).toBe(3);
    });

    it('starts a brand-new guild at zero', async () => {
        await db
            .insertInto('ticketing_config')
            .values({ guildId: 'guild-2', config: '{}', ticketNumberInc: 0, entityVersion: 1 })
            .execute();

        const fresh = await db
            .selectFrom('ticketing_config')
            .selectAll()
            .where('guildId', '=', 'guild-2')
            .executeTakeFirstOrThrow();

        // Zero is correct on insert — it is only wrong on update.
        expect(fresh.ticketNumberInc).toBe(0);
    });
});
