import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { SqliteBindingPlugin } from '../plugins/sqliteBindingPlugin';

/**
 * Booleans read back on real sqlite, through the plugin order `database.ts` uses: the
 * binding plugin before CamelCasePlugin, so a multi-word column reaches it still snake_case.
 * Registered as `photoBonus`, it must still turn `photo_bonus` back into a boolean.
 */

interface FlagTable {
    id: number;
    enabled: boolean;
    photoBonus: boolean;
}

const sqlite = new SqliteDatabase(':memory:');
sqlite.exec('create table flags (id integer primary key, enabled integer not null, photo_bonus integer not null)');

const db = new Kysely<{ flags: FlagTable }>({
    dialect: new SqliteDialect({ database: async () => sqlite }),
    plugins: [new SqliteBindingPlugin<{ flags: FlagTable }>({ flags: ['enabled', 'photoBonus'] }), new CamelCasePlugin()],
});

afterAll(async () => {
    await db.destroy();
});

describe('SqliteBindingPlugin results', () => {
    it('reads one-word and multi-word boolean columns back as booleans, not 0/1', async () => {
        await db.insertInto('flags').values({ id: 1, enabled: true, photoBonus: true }).execute();
        await db.insertInto('flags').values({ id: 2, enabled: false, photoBonus: false }).execute();

        const rows = await db.selectFrom('flags').selectAll().orderBy('id').execute();

        expect(rows).toEqual([
            { id: 1, enabled: true, photoBonus: true },
            { id: 2, enabled: false, photoBonus: false },
        ]);
    });
});
