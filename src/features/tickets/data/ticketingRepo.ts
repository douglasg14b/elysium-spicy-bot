import { database } from '../../../features-system/data-persistence/database';
import { TicketingConfigEntity, NewTicketingConfigEntity, TicketingConfigUpdateEntity } from './ticketingSchema';

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
