import { database } from '../../../features-system/data-persistence/database';
import { DB_TYPE } from '../../../environment';
import {
    TicketingConfigEntity,
    NewTicketingConfigEntity,
    TicketingConfigUpdateEntity,
    type TicketingConfig,
} from './ticketingSchema';

export class TicketingRepo {
    async get(guildId: string): Promise<TicketingConfigEntity | null> {
        const config = await database
            .selectFrom('ticketing_config')
            .selectAll()
            .where('guildId', '=', guildId)
            .executeTakeFirst();

        return config || null;
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
     */
    async upsert(config: NewTicketingConfigEntity): Promise<TicketingConfigEntity> {
        const existing = await this.get(config.guildId);

        if (existing) {
            const { ticketNumberInc: _counter, ...settings } = config;
            await this.update(settings);
        } else {
            await database.insertInto('ticketing_config').values(config).execute();
        }

        return (await this.get(config.guildId)) as TicketingConfigEntity;
    }

    async update(config: TicketingConfigUpdateEntity & { guildId: string }): Promise<void> {
        const { guildId, ...updateData } = config;
        await database.updateTable('ticketing_config').set(updateData).where('guildId', '=', guildId).execute();
    }

    async delete(guildId: string): Promise<void> {
        await database.deleteFrom('ticketing_config').where('guildId', '=', guildId).execute();
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
     * Returns the config as written, or null when `mutate` refused. `mutate` gets the
     * row as it is *inside* the transaction, never a copy read earlier.
     *
     * **Not `entityVersion`.** That column is a schema-migration marker here — every
     * writer hardcodes `1` and nothing compares it — so overloading it as an
     * optimistic-concurrency counter would give one name two meanings and silently
     * change what an existing row's `1` asserts.
     */
    async mutateConfig(
        guildId: string,
        mutate: (current: TicketingConfigEntity) => Promise<TicketingConfig | null> | TicketingConfig | null
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

            const next = await mutate(existing);
            if (!next) return null;

            await transaction
                .updateTable('ticketing_config')
                .set({ config: JSON.stringify(next) })
                .where('guildId', '=', guildId)
                .execute();

            return next;
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

export const ticketingRepo = new TicketingRepo();
