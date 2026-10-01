import { Kysely, sql } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Replace the three ticket category **names** with three category slots (issue #22).
 *
 * Each old name becomes an **unbound** slot, `{ name, discordId: null }`: the expected
 * name is kept, and no id is guessed from it. Guessing would mean matching
 * `channel.name`, which is the defect being removed, and a migration has no guild to
 * match against anyway. An empty or missing name becomes `null`, "nothing chosen". Until
 * the operator links each slot on the dashboard, `isTicketingConfigConfigured` is false
 * and ticket actions refuse by name — the decided cost of not guessing.
 *
 * **Both arms name the `categories` path explicitly** (`json_set … '$.categories'` and
 * `jsonb_set … '{categories}'`), for the reason `2026-09-23-Add_Ticket_Identity_And_Types`
 * records: a shallow `jsonb ||` merge once wrote a seed at the wrong level with nothing
 * raising an error. Guarded on `categories` being absent, so a re-run is a no-op and a
 * row already holding bindings is never reset.
 *
 * `UPDATE`-only is correct. A row created after this runs comes from
 * `/deploy-ticket-system` or the config modal, both of which write `categories`.
 *
 * **`down` restores the names and loses the ids.** The code before this cannot read an
 * id, so the names are all it can use; a slot with nothing chosen goes back to `''`, which
 * that code read as "not configured".
 */

const NAME_KEYS = {
    open: 'supportTicketCategoryName',
    claimed: 'claimedTicketCategoryName',
    closed: 'closedTicketCategoryName',
} as const;

const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await sql`
                update ticketing_config
                set config = jsonb_set(
                        config,
                        '{categories}',
                        jsonb_build_object(
                            'open', ${postgresSlot(NAME_KEYS.open)},
                            'claimed', ${postgresSlot(NAME_KEYS.claimed)},
                            'closed', ${postgresSlot(NAME_KEYS.closed)}
                        ),
                        true
                    )
                    - ${sql.lit(NAME_KEYS.open)}
                    - ${sql.lit(NAME_KEYS.claimed)}
                    - ${sql.lit(NAME_KEYS.closed)}
                where not (config ? 'categories')
            `.execute(db);
        },
        down: async (db: Kysely<any>) => {
            await sql`
                update ticketing_config
                set config = (config - 'categories')
                    || jsonb_build_object(
                        ${sql.lit(NAME_KEYS.open)}, coalesce(config #>> '{categories,open,name}', ''),
                        ${sql.lit(NAME_KEYS.claimed)}, coalesce(config #>> '{categories,claimed,name}', ''),
                        ${sql.lit(NAME_KEYS.closed)}, coalesce(config #>> '{categories,closed,name}', '')
                    )
                where config ? 'categories'
            `.execute(db);
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            // `json(...)` around each slot keeps the JSON subtype through the `case`, so
            // `json_object` nests an object rather than a quoted string. A SQL `null`
            // becomes JSON `null`.
            await sql`
                update ticketing_config
                set config = json_remove(
                    json_set(
                        config,
                        '$.categories',
                        json_object(
                            'open', ${sqliteSlot(NAME_KEYS.open)},
                            'claimed', ${sqliteSlot(NAME_KEYS.claimed)},
                            'closed', ${sqliteSlot(NAME_KEYS.closed)}
                        )
                    ),
                    ${'$.' + NAME_KEYS.open},
                    ${'$.' + NAME_KEYS.claimed},
                    ${'$.' + NAME_KEYS.closed}
                )
                where json_type(config, '$.categories') is null
            `.execute(db);
        },
        down: async (db: Kysely<any>) => {
            await sql`
                update ticketing_config
                set config = json_set(
                    json_remove(config, '$.categories'),
                    ${'$.' + NAME_KEYS.open}, coalesce(json_extract(config, '$.categories.open.name'), ''),
                    ${'$.' + NAME_KEYS.claimed}, coalesce(json_extract(config, '$.categories.claimed.name'), ''),
                    ${'$.' + NAME_KEYS.closed}, coalesce(json_extract(config, '$.categories.closed.name'), '')
                )
                where json_type(config, '$.categories') is not null
            `.execute(db);
        },
    },
};

/** One slot from one old name key, on postgres: an unbound slot, or `null` when unnamed. */
function postgresSlot(nameKey: string) {
    return sql`case
        when coalesce(config ->> ${sql.lit(nameKey)}, '') = '' then 'null'::jsonb
        else jsonb_build_object('name', config ->> ${sql.lit(nameKey)}, 'discordId', null)
    end`;
}

/** The same, on sqlite. */
function sqliteSlot(nameKey: string) {
    const path = '$.' + nameKey;
    return sql`json(case
        when coalesce(json_extract(config, ${path}), '') = '' then null
        else json_object('name', json_extract(config, ${path}), 'discordId', null)
    end)`;
}
