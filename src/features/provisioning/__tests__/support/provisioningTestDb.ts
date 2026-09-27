import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely';
import { DB_TYPE } from '../../../../environment';
import type { Database, DatabaseClient } from '../../../../features-system/data-persistence/database';
import { SqlDatePlugin } from '../../../../features-system/data-persistence/plugins/sqlDatePlugin';
import { SqliteBindingPlugin } from '../../../../features-system/data-persistence/plugins/sqliteBindingPlugin';
import { SqliteJsonPlugin } from '../../../../features-system/data-persistence/plugins/sqliteJsonPlugin';
import { up as createResourceBindings } from '../../../../features-system/data-persistence/migrations/2026-09-18-Create_Resource_Bindings';

export interface ProvisioningTestDb {
    readonly db: DatabaseClient;
}

/**
 * Every migration dispatches on `DB_TYPE`, so a shell exporting `DB_TYPE=postgres` would
 * run `timestamptz` DDL into in-memory SQLite and fail confusingly. Say so plainly.
 */
function assertSqliteDialect(): void {
    if (DB_TYPE !== 'sqlite') {
        throw new Error(
            `provisioningTestDb builds an in-memory SQLite database, but DB_TYPE is "${DB_TYPE}". ` +
                'Unset DB_TYPE (vitest.setup.ts defaults it to sqlite) before running these suites.'
        );
    }
}

/**
 * An in-memory `resource_bindings` table for driving the real `resourceBindingsRepo`.
 *
 * Wired with the plugin stack `database.ts` uses for sqlite, restricted to this table —
 * which today means only date parsing: `resource_bindings` has no boolean or JSON
 * columns, so the two sqlite-only plugins are present with nothing to do, kept so the
 * order matches production if a column ever needs one.
 *
 * The table is built by running the **real migration**, never hand-written DDL. A local
 * `CREATE TABLE` would happily pass while the shipped schema was wrong — the same reason
 * `flowRunsTestDb` does it this way.
 *
 * A test swaps this in for the `database` singleton with `vi.mock`, exactly as the ticket
 * integration tests do, so the repo under test is the production module unmodified.
 */
export async function createProvisioningTestDb(): Promise<ProvisioningTestDb> {
    assertSqliteDialect();

    const sqlite = new SqliteDatabase(':memory:');
    const db: DatabaseClient = new Kysely<Database>({
        dialect: new SqliteDialect({ database: async () => sqlite }),
        plugins: [
            new SqliteBindingPlugin<Database>({}),
            new SqliteJsonPlugin<Database>({}),
            new CamelCasePlugin(),
            new SqlDatePlugin<Database>({ resource_bindings: ['createdAt', 'updatedAt'] }),
        ],
    });

    await createResourceBindings(db);

    return { db };
}

/**
 * How long a service call may take before it is reported as a deadlock.
 *
 * Kysely's `SqliteDialect` has one connection behind a mutex. A query on the singleton
 * from inside a transaction waits forever on a mutex its own caller holds — and poisons
 * the connection for every test after it, burying the cause under unrelated timeouts.
 */
const DEADLOCK_TIMEOUT_MS = 3000;

/**
 * Race a call against a timer, so a deadlock reports as a deadlock.
 *
 * Vitest's own `testTimeout` would eventually fail the run, but as "timed out", with no
 * hint that the connection is wedged. Same guard as `deleteTicketType.integration.test.ts`,
 * with the timer cleared on settle so a passing test leaves no handle open.
 */
export async function withinDeadlockTimeout<T>(work: Promise<T>, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
            () =>
                reject(
                    new Error(
                        `${label} did not settle within ${DEADLOCK_TIMEOUT_MS}ms — almost certainly a query on the ` +
                            'database singleton issued from inside a transaction on the one sqlite connection.'
                    )
                ),
            DEADLOCK_TIMEOUT_MS
        );
    });

    try {
        return await Promise.race([work, timedOut]);
    } finally {
        clearTimeout(timer);
    }
}
