import { database } from '../../../features-system/data-persistence/database';
import type {
    NewTicketEntity,
    TicketEntity,
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

    async listByGuild(guildId: string, status?: TicketStatus): Promise<TicketEntity[]> {
        let query = database.selectFrom('tickets').selectAll().where('guildId', '=', guildId);

        if (status) {
            query = query.where('status', '=', status);
        }

        return query.orderBy('ticketNumber', 'desc').execute();
    }

    /**
     * Claims a ticket only if it is still open and unclaimed.
     *
     * The guard is in the `where` clause rather than in a preceding read,
     * because check-then-act across two statements lets two moderators both pass
     * the check and the second silently win — telling the first they claimed a
     * ticket they did not. Zero rows back *is* the refusal.
     */
    async claimIfUnclaimed(id: number, claimerId: string, claimedAt: string): Promise<TicketEntity | null> {
        const claimed = await database
            .updateTable('tickets')
            .set({ claimerId, claimedAt, updatedAt: claimedAt })
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
