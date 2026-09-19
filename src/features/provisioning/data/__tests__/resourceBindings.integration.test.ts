import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect, sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { up as createResourceBindings } from '../../../../features-system/data-persistence/migrations/2026-09-18-Create_Resource_Bindings';

/**
 * The binding table's guards, against real SQL.
 *
 * These are the crash-safety and race primitives — `onConflict do nothing`, and the
 * `state = 'intended'` guards on settle and discard. A mocked repo cannot answer what
 * an UPDATE actually sets or whether a unique index actually rejects a row, which is
 * the only question that matters here.
 *
 * Runs the migration's own sqlite arm rather than a hand-written schema, so the table
 * under test is the table that ships. A local `CREATE TABLE` would happily pass while
 * the real migration was wrong.
 */

interface TestDatabase {
    resource_bindings: {
        id: number;
        guildId: string;
        journeyKey: string;
        resourceKey: string;
        kind: string;
        state: string;
        discordId: string | null;
        name: string;
        createdAt: string;
        updatedAt: string;
    };
}

let db: Kysely<TestDatabase>;

const GUILD = 'guild-1';
const JOURNEY = 'onboarding';

beforeAll(async () => {
    db = new Kysely<TestDatabase>({
        dialect: new SqliteDialect({ database: new SqliteDatabase(':memory:') }),
        // CamelCasePlugin only — this table has no dates the repo reads back as
        // `Date`, so SqlDatePlugin is not needed. Where both are used, CamelCase
        // must come first or SqlDatePlugin never matches its camelCase keys.
        plugins: [new CamelCasePlugin()],
    });

    process.env.DB_TYPE = 'sqlite';
    // The migration signature is `Kysely<any>`, as every migration in this repo is —
    // a migration describes a schema that does not exist yet, so it cannot be typed
    // against `Database`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createResourceBindings(db as unknown as Kysely<any>);
});

afterAll(async () => {
    await db.destroy();
});

beforeEach(async () => {
    await db.deleteFrom('resource_bindings').execute();
});

async function insertIntent(resourceKey: string, overrides: Record<string, unknown> = {}) {
    const now = new Date().toISOString();
    await db
        .insertInto('resource_bindings')
        .values({
            guildId: GUILD,
            journeyKey: JOURNEY,
            resourceKey,
            kind: 'textChannel',
            state: 'intended',
            discordId: null,
            name: 'welcome',
            createdAt: now,
            updatedAt: now,
            ...overrides,
        } as never)
        .execute();

    return db
        .selectFrom('resource_bindings')
        .selectAll()
        .where('resourceKey', '=', resourceKey)
        .executeTakeFirstOrThrow();
}

describe('the resource_bindings table', () => {
    it('permits a null discord_id, which is what an intent row is', async () => {
        // The whole crash-safety design depends on a row existing before the guild
        // object does. A not-null constraint here would break it.
        const binding = await insertIntent('welcome-channel');
        expect(binding.discordId).toBeNull();
        expect(binding.state).toBe('intended');
    });

    it('rejects a second binding for the same key triple', async () => {
        await insertIntent('welcome-channel');

        await expect(insertIntent('welcome-channel')).rejects.toThrow(/unique/i);
    });

    it('allows the same resource key under a different journey', async () => {
        // Two journeys may each declare `welcome-channel` and mean different things.
        await insertIntent('welcome-channel');
        await insertIntent('welcome-channel', { journeyKey: 'verification' });

        const rows = await db.selectFrom('resource_bindings').selectAll().execute();
        expect(rows).toHaveLength(2);
    });

    it('defaults timestamps to ISO-8601 with an explicit Z', async () => {
        // `CURRENT_TIMESTAMP` would yield a space-separated zoneless string that V8
        // parses as local time, silently wrong off a UTC host.
        await db
            .insertInto('resource_bindings')
            .values({
                guildId: GUILD,
                journeyKey: JOURNEY,
                resourceKey: 'defaults',
                kind: 'role',
                state: 'intended',
                discordId: null,
                name: 'Verified',
            } as never)
            .execute();

        const row = await db
            .selectFrom('resource_bindings')
            .selectAll()
            .where('resourceKey', '=', 'defaults')
            .executeTakeFirstOrThrow();

        expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
});

describe('the intent guards, as real UPDATE statements', () => {
    it('settles an intended row exactly once', async () => {
        const binding = await insertIntent('welcome-channel');

        const settle = async () =>
            db
                .updateTable('resource_bindings')
                .set({ discordId: 'chan-1', state: 'created', updatedAt: new Date().toISOString() })
                .where('id', '=', binding.id)
                .where('state', '=', 'intended')
                .executeTakeFirst();

        expect(Number((await settle()).numUpdatedRows)).toBe(1);
        // The second attempt is the losing half of a race: the guard, not a check.
        expect(Number((await settle()).numUpdatedRows)).toBe(0);
    });

    it('refuses to settle a row that is already created', async () => {
        const binding = await insertIntent('welcome-channel', {
            state: 'created',
            discordId: 'chan-original',
        });

        const result = await db
            .updateTable('resource_bindings')
            .set({ discordId: 'chan-usurper', state: 'created' })
            .where('id', '=', binding.id)
            .where('state', '=', 'intended')
            .executeTakeFirst();

        expect(Number(result.numUpdatedRows)).toBe(0);

        const after = await db
            .selectFrom('resource_bindings')
            .selectAll()
            .where('id', '=', binding.id)
            .executeTakeFirstOrThrow();
        expect(after.discordId).toBe('chan-original');
    });

    it('discards only an intended row, never a live binding', async () => {
        const live = await insertIntent('live-channel', {
            state: 'created',
            discordId: 'chan-live',
        });
        const pending = await insertIntent('pending-channel');

        const discard = (id: number) =>
            db
                .deleteFrom('resource_bindings')
                .where('id', '=', id)
                .where('state', '=', 'intended')
                .executeTakeFirst();

        expect(Number((await discard(live.id)).numDeletedRows)).toBe(0);
        expect(Number((await discard(pending.id)).numDeletedRows)).toBe(1);
    });

    it('rebinds a settled row only when it still points where expected', async () => {
        // The recreate path: the bound channel was deleted, so the binding must move
        // to the replacement — but not if it changed underneath us.
        const binding = await insertIntent('welcome-channel', {
            state: 'created',
            discordId: 'chan-gone',
        });

        const rebind = (expected: string, next: string) =>
            db
                .updateTable('resource_bindings')
                .set({ discordId: next, state: 'created', updatedAt: new Date().toISOString() })
                .where('id', '=', binding.id)
                .where('discordId', '=', expected)
                .executeTakeFirst();

        expect(Number((await rebind('chan-gone', 'chan-new')).numUpdatedRows)).toBe(1);
        // A stale expectation must not clobber the binding that already moved.
        expect(Number((await rebind('chan-gone', 'chan-wrong')).numUpdatedRows)).toBe(0);

        const after = await db
            .selectFrom('resource_bindings')
            .selectAll()
            .where('id', '=', binding.id)
            .executeTakeFirstOrThrow();
        expect(after.discordId).toBe('chan-new');
    });

    it('converges when two installs record the same intent', async () => {
        // `onConflict do nothing` plus a follow-up read, which is how the repo avoids
        // a check-then-insert race.
        const now = new Date().toISOString();
        const values = {
            guildId: GUILD,
            journeyKey: JOURNEY,
            resourceKey: 'welcome-channel',
            kind: 'textChannel',
            state: 'intended',
            discordId: null,
            name: 'welcome',
            createdAt: now,
            updatedAt: now,
        };

        for (let attempt = 0; attempt < 2; attempt += 1) {
            await db
                .insertInto('resource_bindings')
                .values(values as never)
                .onConflict((oc) =>
                    oc.columns(['guildId', 'journeyKey', 'resourceKey']).doNothing()
                )
                .execute();
        }

        const rows = await db.selectFrom('resource_bindings').selectAll().execute();
        expect(rows).toHaveLength(1);
    });

    it('uses the unique index to find a binding rather than scanning', async () => {
        await insertIntent('welcome-channel');

        const plan = await sql<{
            detail: string;
        }>`EXPLAIN QUERY PLAN SELECT * FROM resource_bindings WHERE guild_id = ${GUILD} AND journey_key = ${JOURNEY} AND resource_key = 'welcome-channel'`.execute(
            db
        );

        expect(plan.rows.map((row) => row.detail).join(' ')).toMatch(/USING INDEX/i);
    });
});
