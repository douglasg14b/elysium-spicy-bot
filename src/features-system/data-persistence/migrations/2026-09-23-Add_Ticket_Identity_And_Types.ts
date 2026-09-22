import { Kysely, sql } from 'kysely';
import { DB_TYPE } from '../../../environment';
import { DEFAULT_TICKET_TYPES } from '../../../features/tickets/data/defaultTicketTypes';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Give a ticket row the names of the people on it, and give every guild its own
 * ticket types.
 *
 * Two changes in one migration because one migration beats two, and they land
 * together on purpose: nothing may read `config.ticketTypes` before every existing
 * row has it.
 *
 * **Seven columns, all nullable, no defaults.** Six are identity snapshots and the
 * seventh is `state_message_id`, named separately so the "six identity columns"
 * framing does not absorb it silently. Nullable is forced rather than chosen: this
 * alters a table with live rows, and a snapshot is a fact about a write that has not
 * happened yet for them. `''` would be a username.
 *
 * **The seed is the first migration in this repo that rewrites a stored JSON
 * value**, so it is guarded and its `down` is asymmetric. `2026-09-14-Add_Flow_Run_Variables`
 * could say "this migration only ever adds: no stored row is rewritten, so nothing
 * here can lose a value" — this one cannot, which is why the guard exists.
 * `2026-09-22-Create_Flow_Journey_Links`'s own backfill is an `insert … select` into a
 * brand-new table and is **not** precedent for this.
 *
 * **Columns are named in raw snake_case**, as they must be. Note that the reason is
 * *not* "the migrator has no plugins" — `migrate.ts` passes the app's own `database`,
 * which registers `CamelCasePlugin` and, on sqlite, `SqliteJsonPlugin` for
 * `ticketing_config.config`. The reason is that raw `sql` template fragments are not
 * transformed at all, so what is written here is what reaches the database.
 *
 * **`DEFAULT_TICKET_TYPES` is imported from app code, deliberately.** No other
 * migration here imports from `src/features/`, and the alternative is a JSON literal
 * that must stay byte-identical to the TypeScript record — two copies of a seeded
 * permission model is exactly the drift the type definitions were lifted to data to
 * prevent. `data/defaultTicketTypes.ts` imports nothing but types, so the runtime
 * import list is empty; and it is imported by **direct path**, never through
 * `logic/index.ts`, whose barrel reaches `logic/ticketTypes.ts` and its
 * `import { PermissionsBitField } from 'discord.js'`. `migrate.ts` dynamically
 * `import()`s every file in this directory before any migration runs, so one bad
 * import breaks all twenty-one, not just this one.
 */
/**
 * The seed value: the **bare** type record, keyed by type name, with no `ticketTypes`
 * wrapper.
 *
 * Both dialect arms now name the `ticketTypes` path in their SQL — sqlite via
 * `json_set(config, '$.ticketTypes', …)`, postgres via
 * `jsonb_set(config, '{ticketTypes}', …)` — so both take this shape and neither needs a
 * pre-wrapped variant.
 *
 * **This is the trap that was here.** The postgres arm originally used `jsonb ||`, a
 * shallow merge of *top-level* keys that supplies no path. Handed this bare record it
 * wrote `support` and `verification` as siblings of `modTicketsDeployed` and left
 * `config.ticketTypes` undefined — so the `where not (config ? 'ticketTypes')` guard
 * never cleared (not idempotent) *and* every button on every existing ticket refused,
 * with nothing raising an error. Exported so a test can pin the shape without a postgres
 * database; see `ticketIdentitySnapshots.integration.test.ts`.
 */
export const TICKET_TYPES_JSON = JSON.stringify(DEFAULT_TICKET_TYPES);

/** The config members this step deletes: the phantom template and the never-read user panel. */
const DEAD_CONFIG_MEMBERS = [
    'ticketChannelNameTemplate',
    'userTicketsDeployed',
    'userTicketsDeployedChannelId',
    'userTicketsDeployedMessageId',
] as const;

const IDENTITY_COLUMNS = [
    'subject_username',
    'subject_nickname',
    'opener_username',
    'opener_nickname',
    'claimer_username',
    'claimer_nickname',
    'state_message_id',
] as const;

const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .alterTable('tickets')
                .addColumn('subject_username', 'text')
                .addColumn('subject_nickname', 'text')
                .addColumn('opener_username', 'text')
                .addColumn('opener_nickname', 'text')
                .addColumn('claimer_username', 'text')
                .addColumn('claimer_nickname', 'text')
                .addColumn('state_message_id', 'text')
                .execute();

            // `jsonb_set` with an explicit `'{ticketTypes}'` path rather than `||` with a
            // pre-wrapped object, so this arm states the same path the sqlite arm's
            // `json_set` states and cannot silently merge at the wrong level. `- 'key'`
            // removes a top-level key — not a path — so the four dead members go and
            // their siblings stay.
            //
            // Guarded on the key being absent so a re-run is a no-op, and so a guild
            // that has already authored its own third type cannot have it replaced by
            // the two seeded ones.
            await sql`
                update ticketing_config
                set config = jsonb_set(config, '{ticketTypes}', ${sql.lit(TICKET_TYPES_JSON)}::jsonb, true)
                    - ${sql.lit(DEAD_CONFIG_MEMBERS[0])}
                    - ${sql.lit(DEAD_CONFIG_MEMBERS[1])}
                    - ${sql.lit(DEAD_CONFIG_MEMBERS[2])}
                    - ${sql.lit(DEAD_CONFIG_MEMBERS[3])}
                where not (config ? 'ticketTypes')
            `.execute(db);
        },
        down: async (db: Kysely<any>) => {
            await db.schema
                .alterTable('tickets')
                .dropColumn('subject_username')
                .dropColumn('subject_nickname')
                .dropColumn('opener_username')
                .dropColumn('opener_nickname')
                .dropColumn('claimer_username')
                .dropColumn('claimer_nickname')
                .dropColumn('state_message_id')
                .execute();
            // `config` is deliberately left alone. Stripping `ticketTypes` back out to
            // undo a *schema* change would delete operator-authored types, which is a
            // far worse outcome than a config carrying a member the old code ignores.
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            // sqlite's ALTER TABLE takes one column at a time; the postgres arm can
            // batch. Same seven columns, same order, same nullability.
            for (const column of IDENTITY_COLUMNS) {
                await db.schema.alterTable('tickets').addColumn(column, 'text').execute();
            }

            // `config` is `text` on sqlite and `jsonb` on postgres — the divergence
            // `SqliteJsonPlugin` hides for the app and which the bare migrator does not
            // get — so the two arms are genuinely different SQL rather than one
            // statement with different types. `better-sqlite3` ships JSON1, so
            // `json_set`/`json_remove`/`json_extract` are available; `json_set` returns
            // text and the column stays text.
            await sql`
                update ticketing_config
                set config = json_remove(
                    json_set(config, '$.ticketTypes', json(${TICKET_TYPES_JSON})),
                    ${'$.' + DEAD_CONFIG_MEMBERS[0]},
                    ${'$.' + DEAD_CONFIG_MEMBERS[1]},
                    ${'$.' + DEAD_CONFIG_MEMBERS[2]},
                    ${'$.' + DEAD_CONFIG_MEMBERS[3]}
                )
                where json_extract(config, '$.ticketTypes') is null
            `.execute(db);
        },
        down: async (db: Kysely<any>) => {
            for (const column of IDENTITY_COLUMNS) {
                await db.schema.alterTable('tickets').dropColumn(column).execute();
            }
            // Same asymmetry as the postgres arm, for the same reason.
        },
    },
};
