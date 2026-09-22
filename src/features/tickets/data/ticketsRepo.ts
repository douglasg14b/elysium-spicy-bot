import { database } from '../../../features-system/data-persistence/database';
import type {
    NewTicketEntity,
    TicketEntity,
    TicketIdentity,
    TicketStatus,
    TicketType,
    TicketUpdateEntity,
} from './ticketsSchema';

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
     * Every ticket in a guild, optionally narrowed by status and type.
     *
     * Unpaginated, so it is for an operator-facing list and **not** for the
     * type-in-use refusal — {@link countByType} and {@link listByType} exist for
     * that, capped and grouped.
     */
    async listByGuild(guildId: string, filter?: { status?: TicketStatus; type?: string }): Promise<TicketEntity[]> {
        let query = database.selectFrom('tickets').selectAll().where('guildId', '=', guildId);

        if (filter?.status) {
            query = query.where('status', '=', filter.status);
        }

        if (filter?.type) {
            query = query.where('type', '=', filter.type);
        }

        return query.orderBy('ticketNumber', 'desc').execute();
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
    async countByType(guildId: string, type: string): Promise<{ status: TicketStatus; count: number }[]> {
        const rows = await database
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
    async listByType(guildId: string, type: string, limit: number): Promise<TicketEntity[]> {
        return database
            .selectFrom('tickets')
            .selectAll()
            .where('guildId', '=', guildId)
            .where('type', '=', type)
            .orderBy('ticketNumber', 'desc')
            .limit(limit)
            .execute();
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
