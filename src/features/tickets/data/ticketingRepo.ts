import type { Transaction } from 'kysely';
import { database } from '../../../features-system/data-persistence/database';
import type { Database, DatabaseClient } from '../../../features-system/data-persistence/database';
import { DB_TYPE } from '../../../environment';
import { resourceBindingsRepo, TICKETS_OWNER, type ResourceBindingEntity } from '../../provisioning';
import {
    parseTypeCategoryKey,
    typeCategoryKey,
    type BoundTicketCategory,
    type NewTicketingConfigEntity,
    type StoredTicketingConfig,
    type StoredTicketingConfigEntity,
    type TicketCategoryBinding,
    type TicketCategorySlot,
    type TicketingConfig,
    type TicketingConfigEntity,
    type TicketingConfigUpdateEntity,
    type TicketTypeCategories,
} from './ticketingSchema';

/**
 * Persistence for a guild's ticket config: the `ticketing_config` row, and — since
 * 2026-10-10 — the three category slots, which are `resource_bindings` rows owned by the
 * ticket feature (`docs/plans/shared-binding-table.md`).
 *
 * **This repo owns both directions.** Every read assembles the stored blob and the slot
 * rows into one `TicketingConfig`, so no reader knows the slots moved. Every write of
 * the blob goes through {@link serializeStoredConfig}, which drops a `categories` member
 * a spread of the assembled config carried along — the table type cannot guard that,
 * because Kysely's insert type for a JSON column is a bare `string`.
 */
export class TicketingRepo {
    /**
     * The guild's config, assembled, or null.
     *
     * Takes an executor for a caller already inside a transaction (`mutateConfig`, and the
     * mutators it hands its transaction to); a singleton read from there deadlocks SQLite.
     */
    async get(guildId: string, executor: DatabaseClient = database): Promise<TicketingConfigEntity | null> {
        const row = await executor
            .selectFrom('ticketing_config')
            .selectAll()
            .where('guildId', '=', guildId)
            .executeTakeFirst();

        return row ? assemble(row, executor) : null;
    }

    /**
     * Creates the guild's config, or updates the settings of an existing one.
     *
     * **`ticketNumberInc` is deliberately excluded from the update path.** A
     * caller naturally passes a whole `NewTicketingConfigEntity` here — which
     * carries `ticketNumberInc: 0`, correct for a first insert — and forwarding
     * that to `update` would zero the counter of a guild that already has
     * tickets. With `(guildId, ticketNumber)` now unique, that is not a cosmetic
     * reset: the next ticket reuses a number and the insert is rejected.
     *
     * Both current callers happen to reach this only when no row exists, so the
     * hazard has never fired. It is excluded structurally rather than left to
     * that continuing to be true.
     *
     * Writes the blob only. Categories are written by the saves in `ticketCategoryChoices` through
     * {@link writeCategoryBindings}; `categories` and `typeCategories` on `config` are dropped.
     */
    async upsert(config: NewTicketingConfigEntity): Promise<TicketingConfigEntity> {
        const existing = await this.get(config.guildId);

        if (existing) {
            const { ticketNumberInc: _counter, ...settings } = config;
            await this.update(settings);
        } else {
            await database
                .insertInto('ticketing_config')
                .values({ ...config, config: serializeStoredConfig(config.config) })
                .execute();
        }

        return (await this.get(config.guildId)) as TicketingConfigEntity;
    }

    async update(config: TicketingConfigUpdateEntity & { guildId: string }): Promise<void> {
        const { guildId, config: stored, ...updateData } = config;
        await database
            .updateTable('ticketing_config')
            .set(stored ? { ...updateData, config: serializeStoredConfig(stored) } : updateData)
            .where('guildId', '=', guildId)
            .execute();
    }

    /**
     * Read-modify-writes the `config` blob inside one transaction.
     *
     * **Why this exists rather than `get` then `update`.** `config` is a single JSON
     * column holding every ticket setting, so any edit is a whole-blob rewrite. Two
     * editors saving at once — the dashboard's config page and the Discord config
     * modal, or two browser tabs — each read the blob, each apply their own change to
     * the copy they read, and the second write silently discards the first. Not a
     * narrow window either: it spans an HTTP round trip and an operator's thinking
     * time.
     *
     * `mutate` may also **refuse**, by returning null, and that is the second reason
     * for the transaction: deleting a ticket type has to count the tickets holding it
     * and then write, and those being two statements is how a type gets deleted out
     * from under a ticket opened in between. Running the count inside the same
     * transaction as the write closes it.
     *
     * `mutate` gets the config **assembled** — the blob and the category slot rows — as
     * it is *inside* the transaction, never a copy read earlier. It returns the blob to
     * store; a spread of what it was handed is fine, since the serializer drops
     * `categories`. A mutator that changes slots writes their rows itself, on the
     * transaction it is given ({@link writeCategoryBindings}).
     *
     * Returns the config as it now stands, **re-assembled from the rows on the same
     * transaction**, so a slot the mutator wrote is in it; or null when `mutate`
     * refused. The settings and ticket-type PUT responses render this, and must show
     * the slots as saved.
     *
     * **`mutate` is handed the transaction, and any query it makes MUST use it.**
     * Kysely's `SqliteDialect` has a single connection behind a mutex — "SQLite only has
     * one single connection", per its own driver — which this transaction holds for its
     * whole duration. A query issued on the module-level `database` singleton from inside
     * `mutate` therefore waits for a mutex that cannot be released until `mutate`
     * returns: a hard deadlock, verified empirically, not a theoretical one. It does not
     * merely hang the request — it poisons the only connection in the process, so every
     * later query for every feature queues behind it forever and the bot is dead until
     * restart. That is why the executor is a parameter rather than something a caller may
     * reach for on its own — and why both assemblies here read on `transaction`.
     *
     * **Not `entityVersion`.** That column is a schema-migration marker here — every
     * writer hardcodes `1` and nothing compares it — so overloading it as an
     * optimistic-concurrency counter would give one name two meanings and silently
     * change what an existing row's `1` asserts.
     */
    async mutateConfig(
        guildId: string,
        mutate: (
            current: TicketingConfigEntity,
            transaction: Transaction<Database>
        ) => Promise<StoredTicketingConfig | null> | StoredTicketingConfig | null
    ): Promise<TicketingConfig | null> {
        return database.transaction().execute(async (transaction) => {
            let select = transaction
                .selectFrom('ticketing_config')
                .selectAll()
                .where('guildId', '=', guildId);

            /*
             * The lock is **postgres-only, and it is not optional there.**
             *
             * Nothing in `database.ts` sets an isolation level, so postgres runs the
             * default READ COMMITTED — under which a read-then-write inside one
             * transaction still loses updates. Two editors both read the pre-image blob,
             * both merge onto it, and the second write wins silently. A transaction alone
             * does *not* prevent that, which is the whole hazard this method exists for,
             * so the row has to be locked explicitly.
             *
             * It cannot be unconditional: sqlite has no `FOR UPDATE`, `better-sqlite3`
             * rejects the statement outright with `near "for": syntax error`, and sqlite
             * is the dialect CI runs — so a bare `.forUpdate()` would break every config
             * save on the only arm anything exercises. sqlite needs no lock anyway: the
             * `SELECT` takes a SHARED lock that serializes writers, and the loser gets
             * `SQLITE_BUSY` rather than quietly clobbering.
             *
             * The two arms therefore reach the same guarantee by different means, and
             * each one names its own dialect rather than leaving them to look equivalent.
             */
            if (DB_TYPE === 'postgres') {
                select = select.forUpdate();
            }

            const existing = await select.executeTakeFirst();

            if (!existing) return null;

            const next = await mutate(await assemble(existing, transaction), transaction);
            if (!next) return null;

            await transaction
                .updateTable('ticketing_config')
                .set({ config: serializeStoredConfig(next) })
                .where('guildId', '=', guildId)
                .execute();

            return (await assemble({ ...existing, config: next }, transaction)).config;
        });
    }

    /**
     * Record categories, each as the ticket feature's binding row under its key: a slot
     * name for a server-wide slot, {@link typeCategoryKey} for a type's own.
     *
     * Called from inside a `mutateConfig` mutator with its transaction, so the categories
     * and the rest of the save land together. Nothing here checks who else holds a
     * category; `ticketCategoryChoices` asks on the same transaction first.
     */
    async writeCategoryBindings(
        guildId: string,
        bindings: ReadonlyMap<string, BoundTicketCategory>,
        executor: DatabaseClient
    ): Promise<void> {
        for (const [resourceKey, binding] of bindings) {
            await resourceBindingsRepo.upsertBinding(
                {
                    guildId,
                    owner: TICKETS_OWNER,
                    resourceKey,
                    kind: 'category',
                    state: binding.provenance,
                    discordId: binding.discordId,
                    name: binding.name,
                },
                executor
            );
        }
    }

    /**
     * Drop a type's own categories in these slots, so the type uses the server's again.
     * The categories stay in Discord. On the caller's transaction, as above.
     */
    async clearTypeCategories(
        guildId: string,
        type: string,
        slots: readonly TicketCategorySlot[],
        executor: DatabaseClient
    ): Promise<void> {
        await resourceBindingsRepo.forgetOwned(
            guildId,
            TICKETS_OWNER,
            slots.map((slot) => typeCategoryKey(type, slot)),
            executor
        );
    }

    /**
     * Point every slot bound to a deleted category at its replacement, as `created`.
     *
     * One compare-and-set statement on the slot rows, so two slots that shared the
     * category are both repointed, and a slot the operator re-linked meanwhile is left
     * alone. Returns how many slots moved; zero means none still named the deleted id.
     */
    async repointCategory(guildId: string, deletedId: string, replacementId: string): Promise<number> {
        return resourceBindingsRepo.repointOwned({
            guildId,
            owner: TICKETS_OWNER,
            expectedDiscordId: deletedId,
            discordId: replacementId,
            state: 'created',
        });
    }

    async incrementTicketNumber(guildId: string): Promise<number> {
        const result = await database
            .updateTable('ticketing_config')
            .set((eb) => ({ ticketNumberInc: eb('ticketNumberInc', '+', 1) }))
            .where('guildId', '=', guildId)
            .returning('ticketNumberInc')
            .executeTakeFirst();

        if (!result) {
            throw new Error(`No ticketing config found for guild ${guildId}`);
        }

        return result.ticketNumberInc;
    }
}

/**
 * The stored row with its categories read from the ticket feature's binding rows: the
 * server-wide slots, and each type's own.
 *
 * Both are set last, so a stale member a blob still carried — nothing should write one,
 * but `config` is JSON — never wins over the rows.
 */
async function assemble(row: StoredTicketingConfigEntity, executor: DatabaseClient): Promise<TicketingConfigEntity> {
    const rows = await resourceBindingsRepo.listByOwner(row.guildId, TICKETS_OWNER, executor);
    const slot = (key: TicketCategorySlot): TicketCategoryBinding =>
        slotFromRow(rows.find((binding) => binding.resourceKey === key));

    const typeCategories = new Map<string, TicketTypeCategories>();
    for (const binding of rows) {
        const key = parseTypeCategoryKey(binding.resourceKey);
        const category = slotFromRow(binding);
        if (!key || !category) continue;
        typeCategories.set(key.type, { ...typeCategories.get(key.type), [key.slot]: category });
    }

    return {
        ...row,
        config: {
            ...row.config,
            categories: { open: slot('open'), claimed: slot('claimed'), closed: slot('closed') },
            typeCategories,
        },
    };
}

/**
 * One slot from its row: none is `null`, an `intended` row is a name with no category,
 * and a settled row is bound, its state being the provenance.
 */
function slotFromRow(row: ResourceBindingEntity | undefined): TicketCategoryBinding {
    if (!row) return null;
    if (row.state === 'intended' || !row.discordId) return { name: row.name, discordId: null };
    return { name: row.name, discordId: row.discordId, provenance: row.state };
}

/**
 * The blob as it is stored: everything but `categories` and `typeCategories`.
 *
 * The one place a config becomes the column's text, used by every write. A mutator's
 * natural `{ ...current.config, ticketTypes }` carries the assembled categories along, and
 * writing them back would leave two records of them that can disagree — the very thing
 * the move to binding rows ended.
 */
function serializeStoredConfig(config: StoredTicketingConfig): string {
    const {
        categories: _slots,
        typeCategories: _typeSlots,
        ...stored
    } = config as StoredTicketingConfig & { readonly categories?: unknown; readonly typeCategories?: unknown };
    return JSON.stringify(stored);
}

export const ticketingRepo = new TicketingRepo();
