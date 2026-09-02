import { database, type DatabaseClient } from '../../../features-system/data-persistence/database';
import type { NewWarning, Warning } from './warningsSchema';

export type ActiveWarningMemberSummary = {
    userId: string;
    warningCount: number;
    soonestExpiresAt: Date;
};

function coerceSqlDate(value: string | Date): Date {
    return value instanceof Date ? value : new Date(value);
}

export class WarningsRepo {
    constructor(private readonly db: DatabaseClient = database) {}

    async getByGuildAndSlug(guildId: string, slug: string): Promise<Warning | null> {
        const warning = await this.db
            .selectFrom('warnings')
            .selectAll()
            .where('guildId', '=', guildId)
            .where('slug', '=', slug)
            .executeTakeFirst();

        return warning ?? null;
    }

    async insert(warning: NewWarning): Promise<Warning> {
        await this.db.insertInto('warnings').values(warning).execute();

        const created = await this.getByGuildAndSlug(warning.guildId, warning.slug);
        if (!created) {
            throw new Error(`Warning insert succeeded but row was not found for slug ${warning.slug}`);
        }

        return created;
    }

    async listActive(
        guildId: string,
        asOf: Date,
        options: { limit: number; userId?: string }
    ): Promise<Warning[]> {
        let query = this.db
            .selectFrom('warnings')
            .selectAll()
            .where('guildId', '=', guildId)
            .where('clearedAt', 'is', null)
            .where('expiresAt', '>=', asOf);

        if (options.userId) {
            query = query.where('userId', '=', options.userId);
        }

        return query.orderBy('expiresAt', 'asc').orderBy('id', 'asc').limit(options.limit).execute();
    }

    async countActive(guildId: string, asOf: Date, userId?: string): Promise<number> {
        let query = this.db
            .selectFrom('warnings')
            .select((eb) => eb.fn.countAll<number>().as('count'))
            .where('guildId', '=', guildId)
            .where('clearedAt', 'is', null)
            .where('expiresAt', '>=', asOf);

        if (userId) {
            query = query.where('userId', '=', userId);
        }

        const result = await query.executeTakeFirstOrThrow();
        return Number(result.count);
    }

    async listActiveMemberSummaries(
        guildId: string,
        asOf: Date,
        limit: number
    ): Promise<ActiveWarningMemberSummary[]> {
        const rows = await this.db
            .selectFrom('warnings')
            .select((eb) => [
                'userId',
                eb.fn.countAll<number>().as('warningCount'),
                eb.fn.min<Date>('expiresAt').as('soonestExpiresAt'),
            ])
            .where('guildId', '=', guildId)
            .where('clearedAt', 'is', null)
            .where('expiresAt', '>=', asOf)
            .groupBy('userId')
            .orderBy((eb) => eb.fn.countAll(), 'desc')
            .orderBy((eb) => eb.fn.min('expiresAt'), 'asc')
            .limit(limit)
            .execute();

        return rows.map((row) => ({
            userId: row.userId,
            warningCount: Number(row.warningCount),
            soonestExpiresAt: coerceSqlDate(row.soonestExpiresAt),
        }));
    }

    async countActiveMembers(guildId: string, asOf: Date): Promise<number> {
        const result = await this.db
            .selectFrom('warnings')
            .select((eb) => eb.fn.count<number>('userId').distinct().as('count'))
            .where('guildId', '=', guildId)
            .where('clearedAt', 'is', null)
            .where('expiresAt', '>=', asOf)
            .executeTakeFirstOrThrow();

        return Number(result.count);
    }

    async softClear(guildId: string, slug: string, clearedById: string, clearedAtIso: string): Promise<boolean> {
        const result = await this.db
            .updateTable('warnings')
            .set({
                clearedAt: clearedAtIso,
                clearedById,
            })
            .where('guildId', '=', guildId)
            .where('slug', '=', slug)
            .where('clearedAt', 'is', null)
            .execute();

        return result.some((updateResult) => Number(updateResult.numUpdatedRows) > 0);
    }
}

export const warningsRepo = new WarningsRepo();
