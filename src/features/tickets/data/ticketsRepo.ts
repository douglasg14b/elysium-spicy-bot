import { sql, type Kysely, type Transaction } from 'kysely';
import { database } from '../../../features-system/data-persistence/database';
import type { Database } from '../../../features-system/data-persistence/database';
import type {
    NewTicketEntity,
    TicketEntity,
    TicketIdentity,
    TicketStatus,
    TicketType,
    TicketUpdateEntity,
} from './ticketsSchema';

/**
 * Who runs a read: the shared connection, or a caller's open transaction.
 *
 * Exists because Kysely's `SqliteDialect` has **one** connection behind a mutex. A read
 * issued on the `database` singleton from inside a transaction on that singleton waits
 * for a mutex the transaction still holds — a hard deadlock that poisons the connection
 * for the whole process, not just the request. Any read a `mutateConfig` mutator needs
 * must therefore be given the transaction, which is what this type is for.
 */
export type TicketsExecutor = Kysely<Database> | Transaction<Database>;

/**
 * The most rows a list or search hands back.
 *
 * A ceiling, not a page size — there is no pagination here and adding it would be a
 * bigger change than the surface needs. 200 is comfortably more than an operator reads in
 * one sitting and small enough that the worst case is a bounded response rather than the
 * whole ticket history of a guild.
 *
 * Both list reads ask for `CAP + 1` so the caller can tell "exactly 200" from "more than
 * 200" without a second `count`, and the route turns the extra row into a `truncated` flag
 * plus copy telling the operator to narrow. Enforced in the repo rather than the route so
 * a second caller cannot forget it.
 */
export const TICKET_LIST_CAP = 200;

/**
 * Persistence for durable ticket records.
 *
 * Every read here answers a question a flow condition asks, without a Discord
 * call. That is the point of the table, so a method that resolved a snowflake to
 * answer would defeat it.
 */
export class TicketsRepo {
    async create(ticket: NewTicketEntity): Promise<TicketEntity> {
        const inserted = await database
            .insertInto('tickets')
            .values(ticket)
            .returningAll()
            .executeTakeFirst();

        if (!inserted) {
            throw new Error(`Failed to create ticket for guild ${ticket.guildId}`);
        }

        return inserted;
    }

    async getById(id: number): Promise<TicketEntity | null> {
        const ticket = await database
            .selectFrom('tickets')
            .selectAll()
            .where('id', '=', id)
            .executeTakeFirst();

        return ticket ?? null;
    }

    /**
     * Resolves the ticket a channel belongs to.
     *
     * Deliberately excludes deleted tickets: a channel id can be reused by
     * Discord only in the sense that a *new* ticket may later occupy a fresh
     * channel, but a row whose channel was deleted keeps its old id for history,
     * and returning that to a button handler would let a live interaction act on
     * a dead ticket.
     */
    async getByChannelId(channelId: string): Promise<TicketEntity | null> {
        const ticket = await database
            .selectFrom('tickets')
            .selectAll()
            .where('channelId', '=', channelId)
            .where('status', '!=', 'deleted')
            // Newest wins. `closeTicket` leaves `channelId` populated, so a
            // closed and a reopened ticket can name the same channel; without an
            // order the planner picks, and picks differently on sqlite and
            // postgres.
            .orderBy('id', 'desc')
            .executeTakeFirst();

        return ticket ?? null;
    }

    /**
     * The hot query: does this member have an open ticket of this type?
     *
     * Runs per member on join, which is why the covering index exists.
     */
    /**
     * Whether the subject has any open ticket, without fetching one.
     *
     * Separate from {@link findOpenBySubject} because this runs per member on
     * join and only needs a yes/no. Selecting every column — including `reason`,
     * which is unbounded text — to check `length > 0` forces a table lookup per
     * row and defeats the covering index the migration declares for exactly this
     * question.
     */
    async hasOpenBySubject(guildId: string, subjectId: string, type?: TicketType): Promise<boolean> {
        let query = database
            .selectFrom('tickets')
            .select('id')
            .where('guildId', '=', guildId)
            .where('subjectId', '=', subjectId)
            .where('status', '=', 'open')
            .limit(1);

        if (type) {
            query = query.where('type', '=', type);
        }

        return !!(await query.executeTakeFirst());
    }

    async findOpenBySubject(guildId: string, subjectId: string, type?: TicketType): Promise<TicketEntity[]> {
        let query = database
            .selectFrom('tickets')
            .selectAll()
            .where('guildId', '=', guildId)
            .where('subjectId', '=', subjectId)
            .where('status', '=', 'open');

        if (type) {
            query = query.where('type', '=', type);
        }

        return query.execute();
    }

    /**
     * A guild's tickets, newest first, optionally narrowed by status and type.
     *
     * **Capped at {@link TICKET_LIST_CAP} + 1**, and the extra row is deliberate: it is
     * how a caller distinguishes "exactly the cap" from "more than the cap" without a
     * second `count` query. The route drops it and reports `truncated`.
     *
     * The cap is enforced here rather than left to the caller. This was unbounded, which
     * on a mature guild meant one dashboard load serialising the entire ticket history —
     * every row carrying three participant identities — into a single JSON string, in the
     * same process that runs the Discord gateway. An operator-facing list does not need
     * every row, and the counts strip already tells them the true totals, so a capped
     * list does not lie to anyone.
     *
     * Still **not** for the type-in-use refusal — {@link countByType} and
     * {@link listByType} exist for that, grouped and separately capped.
     */
    async listByGuild(
        guildId: string,
        filter?: { status?: TicketStatus; type?: string; unclaimedOnly?: boolean }
    ): Promise<TicketEntity[]> {
        let query = database.selectFrom('tickets').selectAll().where('guildId', '=', guildId);

        if (filter?.status) {
            query = query.where('status', '=', filter.status);
        }

        if (filter?.type) {
            query = query.where('type', '=', filter.type);
        }

        // A filter rather than a badge on every row. "Unclaimed" is the queue an
        // operator works from, and a marker present on most rows carries no
        // information — so it is something you narrow *to*, not something you scan past.
        if (filter?.unclaimedOnly) {
            query = query.where('claimerId', 'is', null);
        }

        return query
            .orderBy('ticketNumber', 'desc')
            .limit(TICKET_LIST_CAP + 1)
            .execute();
    }

    /**
     * Operator-facing search across a guild's tickets.
     *
     * **Deliberately narrow, and the narrowness is the design.** Two things an operator
     * actually has in hand when they go looking: a ticket number somebody quoted at
     * them, and a person's name. So:
     *
     *  - a query that parses as a positive integer matches `ticketNumber` **exactly**.
     *    Not a prefix or a substring — `#42` means ticket 42, and `LIKE '%42%'` would
     *    bury it under 142, 420 and 1042.
     *  - otherwise it matches the four identity **snapshot** columns case-insensitively.
     *    The snapshots are the reason this can be a query at all: matching on people
     *    without them would mean resolving every snowflake through Discord to filter a
     *    list, which is the cost the columns exist to remove.
     *
     * `lower(column) like lower(:q) || '%'` — **prefix**, not `%…%`. A leading wildcard
     * cannot use an index on any dialect, and a name search that matches mid-word
     * mostly returns noise. Parameterized throughout; the caller's text never reaches
     * the SQL.
     *
     * **No index added, and that is a decision rather than an omission.** These are
     * per-guild operator searches over a table that holds a few thousand rows for a busy
     * guild, behind an authenticated dashboard, run when a human types — so the scan is
     * already narrowed to one guild and costs less than the round trip that carried the
     * request. An index on four lowercased text columns would be four index writes on
     * every ticket write to speed up a query nobody runs in a loop. Revisit if a guild's
     * ticket count reaches six figures.
     *
     * The narrowing rides the leading column of `tickets_guild_number_unique_idx`
     * (`(guild_id, ticket_number)`) — which also serves the `ORDER BY` — rather than a
     * dedicated `guild_id` index, of which there is none. Named precisely because "the
     * indexed guildId predicate" would send the next reader looking for an index that
     * does not exist.
     */
    async searchByGuild(
        guildId: string,
        query: string,
        filter?: { status?: TicketStatus; type?: string; unclaimedOnly?: boolean }
    ): Promise<TicketEntity[]> {
        const trimmed = query.trim();

        let statement = database.selectFrom('tickets').selectAll().where('guildId', '=', guildId);

        if (filter?.status) {
            statement = statement.where('status', '=', filter.status);
        }

        if (filter?.type) {
            statement = statement.where('type', '=', filter.type);
        }

        // The same narrowing the unfiltered list offers, so searching does not silently
        // widen a filter the operator left switched on.
        if (filter?.unclaimedOnly) {
            statement = statement.where('claimerId', 'is', null);
        }

        // Exact rather than prefix: `/^\d+$/` means the operator typed a number, and a
        // number they typed is the number they mean.
        const asNumber = /^\d+$/.test(trimmed) ? Number(trimmed) : null;

        if (asNumber !== null && Number.isSafeInteger(asNumber)) {
            statement = statement.where('ticketNumber', '=', asNumber);
        } else {
            /*
             * `%` and `_` escaped before they become a pattern. Parameterization stops
             * injection but not *interpretation*: a query of `%` is a valid bind value
             * that matches every row, and `a_b` would match `axb`. An operator typing an
             * underscore means an underscore.
             *
             * `\` is the escape character, declared explicitly below because sqlite has no
             * default one — without the `ESCAPE` clause the backslashes would be matched
             * literally, which is the opposite of the fix.
             */
            const escaped = trimmed.toLowerCase().replace(/[\\%_]/g, (match) => `\\${match}`);
            const prefix = `${escaped}%`;

            /*
             * `sql` templates rather than `eb(..., 'like', ...)` only so the `escape`
             * clause can be attached; the pattern is still a bound parameter, never
             * interpolated. Sqlite defines no default escape character and postgres
             * accepts the same clause, so naming it makes both dialects read the
             * backslashes above as escapes rather than as literals.
             *
             * The escape character is a **bound parameter**, not a literal in the
             * template. Writing `escape '\'` inline fails: the backslash escapes the
             * closing quote in the JavaScript string, so sqlite receives a malformed
             * clause and raises `ESCAPE expression must be a single character` — caught by
             * the integration test beside this, which is the only place that shows it.
             */
            const matches = (column: 'subjectUsername' | 'subjectNickname' | 'openerUsername' | 'claimerUsername') =>
                sql<boolean>`lower(${sql.ref(column)}) like ${prefix} escape ${'\\'}`;

            statement = statement.where((eb) =>
                eb.or([
                    matches('subjectUsername'),
                    matches('subjectNickname'),
                    matches('openerUsername'),
                    matches('claimerUsername'),
                ])
            );
        }

        // Same cap as the unfiltered list, and it matters more here: a text search is a
        // full scan over four columns with no index behind it, so an uncapped one lets a
        // scripted caller with a valid session issue an unbounded scan per request.
        return statement
            .orderBy('ticketNumber', 'desc')
            .limit(TICKET_LIST_CAP + 1)
            .execute();
    }

    /**
     * How many tickets of a type exist in a guild, by status.
     *
     * One grouped query rather than three counts, because the refusal that reads
     * this names all three numbers together and an operator sees them at once.
     *
     * `count(*)` arrives as a string on postgres and a number on sqlite, so it is
     * coerced here at the boundary rather than left for each caller to discover.
     */
    async countByType(
        guildId: string,
        type: string,
        executor: TicketsExecutor = database
    ): Promise<{ status: TicketStatus; count: number }[]> {
        const rows = await executor
            .selectFrom('tickets')
            .select(['status', (eb) => eb.fn.countAll<string | number>().as('count')])
            .where('guildId', '=', guildId)
            .where('type', '=', type)
            .groupBy('status')
            .execute();

        return rows.map((row) => ({ status: row.status, count: Number(row.count) }));
    }

    /**
     * A capped, newest-first sample of the tickets holding a type.
     *
     * For the refusal's example numbers. A guild can have thousands of tickets of
     * one type, and a refusal naming all of them is a refusal nobody reads.
     */
    async listByType(
        guildId: string,
        type: string,
        limit: number,
        executor: TicketsExecutor = database
    ): Promise<TicketEntity[]> {
        return executor
            .selectFrom('tickets')
            .selectAll()
            .where('guildId', '=', guildId)
            .where('type', '=', type)
            .orderBy('ticketNumber', 'desc')
            .limit(limit)
            .execute();
    }

    /**
     * The three numbers the dashboard's counts strip shows.
     *
     * One query, not three: the strip renders them together and an operator reads them
     * as one sentence, so three round trips would let them disagree with each other by
     * however long the slowest one took.
     *
     * `unclaimed` counts **open and unclaimed**, which is the queue — a closed ticket
     * with no claimer is history, not work. It is the number this whole strip exists
     * for, because it is the one an operator can act on.
     *
     * Counted rather than derived from the list: the list is filtered, and a strip that
     * changed when you filtered it would be describing the page instead of the guild.
     */
    async countsByGuild(guildId: string): Promise<{ open: number; unclaimed: number; closed: number }> {
        const row = await database
            .selectFrom('tickets')
            .select((eb) => [
                eb.fn
                    .count<string | number>(
                        eb.case().when('status', '=', 'open').then(eb.ref('id')).end()
                    )
                    .as('open'),
                eb.fn
                    .count<string | number>(
                        eb
                            .case()
                            .when(eb.and([eb('status', '=', 'open'), eb('claimerId', 'is', null)]))
                            .then(eb.ref('id'))
                            .end()
                    )
                    .as('unclaimed'),
                eb.fn
                    .count<string | number>(
                        eb.case().when('status', '=', 'closed').then(eb.ref('id')).end()
                    )
                    .as('closed'),
            ])
            .where('guildId', '=', guildId)
            .executeTakeFirst();

        // `count` arrives as a string on postgres and a number on sqlite, coerced here
        // at the boundary rather than left for the caller to discover on one dialect.
        return {
            open: Number(row?.open ?? 0),
            unclaimed: Number(row?.unclaimed ?? 0),
            closed: Number(row?.closed ?? 0),
        };
    }

    /**
     * Claims a ticket only if it is still open and unclaimed.
     *
     * The guard is in the `where` clause rather than in a preceding read,
     * because check-then-act across two statements lets two moderators both pass
     * the check and the second silently win — telling the first they claimed a
     * ticket they did not. Zero rows back *is* the refusal.
     *
     * The claimer's names are set **inside the same conditional UPDATE**. Writing
     * them in a second statement would leave the row claimed by one person under
     * another's name: the losing side of a claim race has its `claimerId` write
     * correctly refused, but an unguarded name write would still land and
     * overwrite the winner's.
     */
    async claimIfUnclaimed(
        id: number,
        claimerId: string,
        claimedAt: string,
        identity: TicketIdentity | null
    ): Promise<TicketEntity | null> {
        const claimed = await database
            .updateTable('tickets')
            .set({
                claimerId,
                claimedAt,
                updatedAt: claimedAt,
                claimerUsername: identity?.username ?? null,
                claimerNickname: identity?.nickname ?? null,
            })
            .where('id', '=', id)
            .where('status', '=', 'open')
            .where('claimerId', 'is', null)
            .returningAll()
            .executeTakeFirst();

        return claimed ?? null;
    }

    /**
     * Moves a ticket's lifecycle only from the status it is expected to be in.
     *
     * Same reasoning as {@link claimIfUnclaimed}. The dangerous interleaving this
     * closes is close racing delete: without the guard the later write lands on
     * top and produces a row that is `closed` but carries `deletedAt` — a state
     * the status union says cannot exist.
     */
    async transitionStatus(
        id: number,
        from: TicketStatus,
        changes: TicketUpdateEntity
    ): Promise<TicketEntity | null> {
        const moved = await database
            .updateTable('tickets')
            .set({ ...changes, updatedAt: new Date().toISOString() })
            .where('id', '=', id)
            .where('status', '=', from)
            .returningAll()
            .executeTakeFirst();

        return moved ?? null;
    }

    async update(id: number, changes: TicketUpdateEntity): Promise<TicketEntity> {
        const updated = await database
            .updateTable('tickets')
            .set({ ...changes, updatedAt: new Date().toISOString() })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirst();

        if (!updated) {
            throw new Error(`No ticket found with id ${id}`);
        }

        return updated;
    }
}

export const ticketsRepo = new TicketsRepo();
