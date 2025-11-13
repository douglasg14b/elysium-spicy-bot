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

    async upsert(config: NewTicketingConfigEntity): Promise<TicketingConfigEntity> {
        const existing = await this.get(config.guildId);
        console.log('Existing config:', existing);
        console.log('Config to upsert:', config);

        if (existing) {
            await this.update(config);
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
