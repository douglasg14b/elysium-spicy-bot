import { database } from '../../../features-system/data-persistence/database';
import type { NewTicketEntity, TicketEntity, TicketStatus, TicketType, TicketUpdateEntity } from './ticketsSchema';

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
            .executeTakeFirst();

        return ticket ?? null;
    }

    /**
     * The hot query: does this member have an open ticket of this type?
     *
     * Runs per member on join, which is why the covering index exists.
     */
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
