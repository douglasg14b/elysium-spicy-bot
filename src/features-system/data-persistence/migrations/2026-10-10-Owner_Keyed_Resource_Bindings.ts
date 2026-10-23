import { Kysely, sql } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * One record of what the bot owns, for journeys and tickets
 * (`docs/plans/shared-binding-table.md`).
 *
 * `resource_bindings` becomes owner-keyed: `journey_key` is renamed `owner_key`, and a new
 * `owner_kind` (`'journey'` | `'tickets'`) says whose key it is. Every existing row is a
 * journey's. Then each guild's three ticket category slots move out of the
 * `ticketing_config.config` blob into rows owned by `('tickets', 'tickets')`, one per
 * slot, so the fences that guard journey objects see ticket categories too.
 *
 * A slot maps to a row as follows, and anything else **throws**, naming the guild and slot:
 *
 *   - `null` → no row;
 *   - `{ name, discordId: null }` → `state: 'intended'`, no id;
 *   - `{ name, discordId, provenance }` → `state: provenance`, with the id.
 *
 * Two slots sharing a category become two rows with the same id and the same owner, which
 * is legal: one owner per object is enforced on claim, not by an index. Ids held by more
 * than one owner — a cross-claim from before that rule — are copied as they are and
 * logged per guild; uninstall forgets rather than deletes them, and drift will not repair
 * them.
 *
 * **Runs on the production migrator stack**, which hands every migration the `database`
 * singleton: `CamelCasePlugin` on both dialects, and on sqlite `SqliteJsonPlugin`, which
 * parses `config`. So `config` arrives as an object on both production dialects but as a
 * string through a bare Kysely, and a result key may or may not be camelCased; both are
 * read either way (`columnOf`, `configObjectOf`), and every write is `JSON.stringify`.
 *
 * **Both arms run the same steps and name the same targets** — the whole `config` column
 * is rewritten from a parsed object, never patched with `jsonb ||` (the hazard
 * `2026-09-23-Add_Ticket_Identity_And_Types` records). They differ only in the
 * transaction: Kysely wraps a postgres migration in one, and not a sqlite one, so the
 * sqlite arm opens its own and uses only `trx` inside it — a query on `db` would wait on
 * the connection the transaction holds and never return.
 *
 * **A re-run is a no-op.** The column change is skipped when `owner_kind` already exists,
 * a slot row that exists is left alone (`ON CONFLICT DO NOTHING`), and a blob with no
 * `categories` member — which is what the first run leaves — is skipped. `down` is
 * guarded the same way, so running it twice cannot wipe the slots it restored.
 *
 * **`down`** writes `categories` back into every config row that lacks it (`null` for a
 * slot with no row: the code before this requires the member on read), deletes rows
 * **where `owner_kind = 'tickets'`** — never by `owner_key`, which would also delete a
 * journey an operator called `tickets` — and only then reverts the columns. Indexes go
 * before the column, because sqlite will not drop a column an index names.
 *
 * The literals below (`'tickets'`, the slot names) are copied rather than imported:
 * a migration must keep meaning what it meant when it ran, whatever the live schema
 * later calls things.
 */

const TICKETS_OWNER_KIND = 'tickets';
const TICKETS_OWNER_KEY = 'tickets';
const SLOTS = ['open', 'claimed', 'closed'] as const;
type Slot = (typeof SLOTS)[number];

type ColumnExists = (db: Kysely<any>) => Promise<boolean>;

const migration = {
    postgres: {
        // Kysely already wraps a postgres migration in a transaction.
        up: async (db: Kysely<any>) => {
            await migrateUp(db, postgresOwnerKindExists);
        },
        down: async (db: Kysely<any>) => {
            await migrateDown(db, postgresOwnerKindExists);
        },
    },
    sqlite: {
        // `SqliteAdapter.supportsTransactionalDdl` is false, so the migrator does not wrap
        // this; the column change and the data move must land together or not at all.
        up: async (db: Kysely<any>) => {
            await db.transaction().execute(async (trx) => {
                await migrateUp(trx, sqliteOwnerKindExists);
            });
        },
        down: async (db: Kysely<any>) => {
            await db.transaction().execute(async (trx) => {
                await migrateDown(trx, sqliteOwnerKindExists);
            });
        },
    },
};

async function postgresOwnerKindExists(db: Kysely<any>): Promise<boolean> {
    const { rows } = await sql<{ found: number }>`
        select 1 as found from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'resource_bindings'
          and column_name = 'owner_kind'
    `.execute(db);
    return rows.length > 0;
}

async function sqliteOwnerKindExists(db: Kysely<any>): Promise<boolean> {
    const { rows } = await sql<{ found: number }>`
        select 1 as found from pragma_table_info('resource_bindings') where name = 'owner_kind'
    `.execute(db);
    return rows.length > 0;
}

async function migrateUp(db: Kysely<any>, ownerKindExists: ColumnExists): Promise<void> {
    if (!(await ownerKindExists(db))) {
        await db.schema
            .alterTable('resource_bindings')
            .addColumn('owner_kind', 'text', (col) => col.notNull().defaultTo('journey'))
            .execute();
        await db.schema.alterTable('resource_bindings').renameColumn('journey_key', 'owner_key').execute();

        await db.schema.dropIndex('resource_bindings_key_unique_idx').execute();
        await db.schema.dropIndex('resource_bindings_guild_journey_idx').execute();
        // Created before any slot row is inserted: the insert's `ON CONFLICT` names it.
        await db.schema
            .createIndex('resource_bindings_owner_key_unique_idx')
            .on('resource_bindings')
            .columns(['guild_id', 'owner_kind', 'owner_key', 'resource_key'])
            .unique()
            .execute();
        await db.schema
            .createIndex('resource_bindings_guild_owner_idx')
            .on('resource_bindings')
            .columns(['guild_id', 'owner_kind', 'owner_key'])
            .execute();
    }

    const now = new Date().toISOString();
    const configRows = await db.selectFrom('ticketing_config').select(['guild_id', 'config']).execute();

    for (const row of configRows) {
        const guildId = String(columnOf(row, 'guild_id', 'guildId'));
        const config = configObjectOf(columnOf(row, 'config', 'config'), guildId);

        // Already moved — the first run removes the member — or never had one.
        if (!('categories' in config)) continue;

        const categories = config.categories;
        if (!isPlainObject(categories)) {
            throw new Error(
                `ticketing_config for guild ${guildId} holds a "categories" member that is not an object, so its ticket category slots cannot be moved. Fix the row by hand, then migrate again.`
            );
        }

        for (const slot of SLOTS) {
            const slotRow = slotRowOf(categories[slot], guildId, slot);
            if (!slotRow) continue;

            await db
                .insertInto('resource_bindings')
                .values({
                    guild_id: guildId,
                    owner_kind: TICKETS_OWNER_KIND,
                    owner_key: TICKETS_OWNER_KEY,
                    resource_key: slot,
                    kind: 'category',
                    state: slotRow.state,
                    discord_id: slotRow.discordId,
                    name: slotRow.name,
                    created_at: now,
                    updated_at: now,
                })
                .onConflict((oc) => oc.columns(['guild_id', 'owner_kind', 'owner_key', 'resource_key']).doNothing())
                .execute();
        }

        const { categories: _moved, ...stored } = config;
        await db
            .updateTable('ticketing_config')
            .set({ config: JSON.stringify(stored) })
            .where('guild_id', '=', guildId)
            .execute();
    }

    await logCrossClaims(db);
}

async function migrateDown(db: Kysely<any>, ownerKindExists: ColumnExists): Promise<void> {
    // Already reverted: there are no owner-keyed rows to read the slots back from, and
    // writing `categories` now would set every slot to null.
    if (!(await ownerKindExists(db))) return;

    const ticketRows = await db
        .selectFrom('resource_bindings')
        .select(['guild_id', 'resource_key', 'state', 'discord_id', 'name'])
        .where('owner_kind', '=', TICKETS_OWNER_KIND)
        .execute();

    const slotsByGuild = new Map<string, Partial<Record<Slot, unknown>>>();
    for (const row of ticketRows) {
        const guildId = String(columnOf(row, 'guild_id', 'guildId'));
        const slot = columnOf(row, 'resource_key', 'resourceKey');
        // A ticket type's own category (`type:<key>:<slot>`, added 2026-10-22) has no place
        // in the blob this restores, so rolling back drops it with the rest of the rows
        // below: those types go back to the server-wide categories.
        if (String(slot).startsWith('type:')) continue;
        if (!isSlot(slot)) {
            throw new Error(`A ticket binding in guild ${guildId} names "${String(slot)}", which is not a category slot.`);
        }
        const state = columnOf(row, 'state', 'state');
        const name = String(columnOf(row, 'name', 'name'));
        const discordId = columnOf(row, 'discord_id', 'discordId');
        const slots = slotsByGuild.get(guildId) ?? {};
        slots[slot] =
            state === 'intended' || !discordId
                ? { name, discordId: null }
                : { name, discordId: String(discordId), provenance: state };
        slotsByGuild.set(guildId, slots);
    }

    const configRows = await db.selectFrom('ticketing_config').select(['guild_id', 'config']).execute();
    for (const row of configRows) {
        const guildId = String(columnOf(row, 'guild_id', 'guildId'));
        const config = configObjectOf(columnOf(row, 'config', 'config'), guildId);
        if ('categories' in config) continue;

        const slots = slotsByGuild.get(guildId) ?? {};
        const categories = Object.fromEntries(SLOTS.map((slot) => [slot, slots[slot] ?? null]));
        await db
            .updateTable('ticketing_config')
            .set({ config: JSON.stringify({ ...config, categories }) })
            .where('guild_id', '=', guildId)
            .execute();
    }

    // By kind, never by key: a journey called `tickets` is a journey, and its rows stay.
    await db.deleteFrom('resource_bindings').where('owner_kind', '=', TICKETS_OWNER_KIND).execute();

    await db.schema.dropIndex('resource_bindings_owner_key_unique_idx').execute();
    await db.schema.dropIndex('resource_bindings_guild_owner_idx').execute();
    await db.schema.alterTable('resource_bindings').dropColumn('owner_kind').execute();
    await db.schema.alterTable('resource_bindings').renameColumn('owner_key', 'journey_key').execute();
    await db.schema
        .createIndex('resource_bindings_key_unique_idx')
        .on('resource_bindings')
        .columns(['guild_id', 'journey_key', 'resource_key'])
        .unique()
        .execute();
    await db.schema
        .createIndex('resource_bindings_guild_journey_idx')
        .on('resource_bindings')
        .columns(['guild_id', 'journey_key'])
        .execute();
}

interface SlotRow {
    readonly state: 'intended' | 'created' | 'adopted';
    readonly discordId: string | null;
    readonly name: string;
}

/** One slot's row, `null` for an empty slot. Any shape the mapping does not name throws. */
function slotRowOf(value: unknown, guildId: string, slot: Slot): SlotRow | null {
    if (value === null) return null;

    if (isPlainObject(value) && typeof value.name === 'string') {
        if (value.discordId === null) {
            return { state: 'intended', discordId: null, name: value.name };
        }
        if (
            typeof value.discordId === 'string' &&
            value.discordId !== '' &&
            (value.provenance === 'created' || value.provenance === 'adopted')
        ) {
            return { state: value.provenance, discordId: value.discordId, name: value.name };
        }
    }

    throw new Error(
        `ticketing_config for guild ${guildId} holds a "${slot}" category slot this migration does not recognise: ${JSON.stringify(value) ?? 'undefined'}. Fix the row by hand, then migrate again.`
    );
}

/**
 * Log every object held by more than one owner, per guild.
 *
 * Only possible with data from before one owner per object: tickets pointed at a category
 * a journey had made, say. Logged rather than refused, because the migration's job is to
 * copy what it finds; the fences then keep it from doing harm (uninstall forgets it, drift
 * will not repair it), and an operator can untangle it knowing which ids to look at.
 */
async function logCrossClaims(db: Kysely<any>): Promise<void> {
    const settled = await db
        .selectFrom('resource_bindings')
        .select(['guild_id', 'owner_kind', 'owner_key', 'discord_id'])
        .where('discord_id', 'is not', null)
        .where('state', '!=', 'intended')
        .execute();

    const ownersByObject = new Map<string, { guildId: string; discordId: string; owners: Set<string> }>();
    for (const row of settled) {
        const guildId = String(columnOf(row, 'guild_id', 'guildId'));
        const discordId = String(columnOf(row, 'discord_id', 'discordId'));
        const owner = `${String(columnOf(row, 'owner_kind', 'ownerKind'))}:${String(columnOf(row, 'owner_key', 'ownerKey'))}`;
        const key = `${guildId}:${discordId}`;
        const entry = ownersByObject.get(key) ?? { guildId, discordId, owners: new Set<string>() };
        entry.owners.add(owner);
        ownersByObject.set(key, entry);
    }

    const byGuild = new Map<string, string[]>();
    for (const { guildId, discordId, owners } of ownersByObject.values()) {
        if (owners.size < 2) continue;
        const lines = byGuild.get(guildId) ?? [];
        lines.push(`${discordId} (${[...owners].sort().join(', ')})`);
        byGuild.set(guildId, lines);
    }

    for (const [guildId, lines] of byGuild) {
        console.warn(
            `[migration] Guild ${guildId} has objects held by more than one owner: ${lines.join('; ')}. Uninstall will forget rather than delete them and drift will not repair them; untangle them by hand.`
        );
    }
}

/** A result column, whether or not `CamelCasePlugin` renamed it. */
function columnOf(row: Record<string, unknown>, snake: string, camel: string): unknown {
    return snake in row ? row[snake] : row[camel];
}

/** `config` as an object: parsed by the production stack, a string through a bare client. */
function configObjectOf(raw: unknown, guildId: string): Record<string, unknown> {
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!isPlainObject(parsed)) {
        throw new Error(`ticketing_config for guild ${guildId} holds a config that is not a JSON object.`);
    }
    return parsed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSlot(value: unknown): value is Slot {
    return (SLOTS as readonly unknown[]).includes(value);
}
