import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect, sql } from 'kysely';
import { DB_TYPE } from '../../../../environment';
import type { Database, DatabaseClient } from '../../database';
import { SqlDatePlugin } from '../../plugins/sqlDatePlugin';
import { SqliteBindingPlugin } from '../../plugins/sqliteBindingPlugin';
import { SqliteJsonPlugin } from '../../plugins/sqliteJsonPlugin';
import { up as createFlowRuns } from '../../migrations/2026-09-12-Create_Flow_Runs';
import { up as settleFlowRunLifecycle } from '../../migrations/2026-09-13-Settle_Flow_Run_Lifecycle';
import { up as addFlowRunVariables } from '../../migrations/2026-09-14-Add_Flow_Run_Variables';

export interface FlowRunsTestDb {
    db: DatabaseClient;
    sqlite: SqliteDatabase.Database;
}

/**
 * Every migration dispatches on `DB_TYPE`, so a shell exporting `DB_TYPE=postgres`
 * would run `timestamptz` DDL into in-memory SQLite and fail confusingly. Say so
 * plainly instead.
 */
function assertSqliteDialect(): void {
    if (DB_TYPE !== 'sqlite') {
        throw new Error(
            `flowRunsTestDb builds an in-memory SQLite database, but DB_TYPE is "${DB_TYPE}". ` +
                'Unset DB_TYPE (vitest.setup.ts defaults it to sqlite) before running these suites.'
        );
    }
}

/**
 * An in-memory Kysely client wired with the same plugin stack `database.ts` uses
 * for sqlite, restricted to what `flow_runs` needs.
 *
 * Exported separately from {@link createFlowRunsTestDb} so a test can apply the
 * migrations itself — the migration test needs the pre-M1 table on purpose.
 */
export function createFlowRunsTestClient(): FlowRunsTestDb {
    assertSqliteDialect();

    const sqlite = new SqliteDatabase(':memory:');

    const db = new Kysely<Database>({
        dialect: new SqliteDialect({ database: async () => sqlite }),
        plugins: [
            new SqliteBindingPlugin<Database>({}),
            new SqliteJsonPlugin<Database>({
                flow_runs: ['waitConfig', 'contextSnapshot', 'log', 'variables'],
            }),
            new CamelCasePlugin(),
            new SqlDatePlugin<Database>({ flow_runs: ['wakeAt', 'claimedAt', 'createdAt', 'updatedAt'] }),
        ],
    }) as DatabaseClient;

    return { db, sqlite };
}

/**
 * A `flow_runs` table built by running the real migrations, rather than by
 * hand-writing the DDL a second time.
 *
 * Hand-mirroring the schema in tests is how a suite ends up green against a table
 * production does not have — and it means the migrations themselves are exercised
 * on every run, which is otherwise true of nothing in this repository.
 */
export async function createFlowRunsTestDb(): Promise<FlowRunsTestDb> {
    const testDb = createFlowRunsTestClient();

    await createFlowRuns(testDb.db);
    await settleFlowRunLifecycle(testDb.db);
    await addFlowRunVariables(testDb.db);

    return testDb;
}

/** A row of the pre-M1 `flow_runs` shape, as the fixtures record it. */
export interface PreM1FlowRunRow {
    run_id: string;
    flow_id: string;
    guild_id: string;
    status: string;
    resume_node_id: string | null;
    wake_at: string | null;
    wait_kind: string | null;
    wait_config: string | null;
    context_snapshot: string;
    visits_used: number;
    log: string;
    error: string | null;
    entity_version: number;
    created_at: string;
    updated_at: string;
}

/**
 * Insert a run row exactly as the pre-M1 code wrote it — including
 * `status = 'pending'`, which the current union no longer has, and without the
 * `claimed_at` column, which did not yet exist.
 *
 * Written out as raw SQL on purpose: going through the typed client would force
 * the row into the *current* shape, which is the one thing these tests must not
 * assume.
 */
export async function insertPreM1FlowRunRow(db: DatabaseClient, row: PreM1FlowRunRow): Promise<void> {
    await sql`
        INSERT INTO flow_runs (
            run_id, flow_id, guild_id, status, resume_node_id, wake_at,
            wait_kind, wait_config, context_snapshot, visits_used, log,
            error, entity_version, created_at, updated_at
        ) VALUES (
            ${row.run_id}, ${row.flow_id}, ${row.guild_id}, ${row.status}, ${row.resume_node_id},
            ${row.wake_at}, ${row.wait_kind}, ${row.wait_config}, ${row.context_snapshot},
            ${row.visits_used}, ${row.log}, ${row.error}, ${row.entity_version},
            ${row.created_at}, ${row.updated_at}
        )
    `.execute(db);
}
