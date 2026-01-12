import { database } from '../../../features-system/data-persistence/database';
import { Birthday, NewBirthday, BirthdayUpdate, BirthdayDisplay } from './birthdaySchema';

export class BirthdayRepository {
    /**
     * Get a user's birthday in a specific guild
     */
    async get(guildId: string, userId: string): Promise<Birthday | null> {
        const birthday = await database
            .selectFrom('birthdays')
            .selectAll()
            .where('guildId', '=', guildId)
            .where('userId', '=', userId)
            .executeTakeFirst();

        return birthday || null;
    }

    /**
     * Get all birthdays for a guild
     */
    async getAllByGuild(guildId: string): Promise<Birthday[]> {
        const birthdays = await database
            .selectFrom('birthdays')
            .selectAll()
            .where('guildId', '=', guildId)
            .orderBy('month', 'asc')
            .orderBy('day', 'asc')
            .execute();

        return birthdays;
    }

    /**
     * Get birthdays for today across all guilds
     */
    async getTodaysBirthdays(): Promise<Birthday[]> {
        const now = new Date();
        const month = now.getMonth() + 1; // JavaScript months are 0-indexed
        const day = now.getDate();

        return await database
            .selectFrom('birthdays')
            .selectAll()
            .where('month', '=', month)
            .where('day', '=', day)
            .execute();
    }

    /**
     * Get upcoming birthdays for a guild within the next N days
     */
    async getUpcomingBirthdays(guildId: string, daysAhead = 7): Promise<BirthdayDisplay[]> {
        const birthdays = await this.getAllByGuild(guildId);
        const now = new Date();
        const currentYear = now.getFullYear();

        return birthdays
            .map((birthday) => {
                let birthdayThisYear = new Date(currentYear, birthday.month - 1, birthday.day);
                let birthdayNextYear = new Date(currentYear + 1, birthday.month - 1, birthday.day);

                // If birthday already passed this year, use next year's date
                if (birthdayThisYear < now) {
                    birthdayThisYear = birthdayNextYear;
                }

                const daysUntil = Math.ceil((birthdayThisYear.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

                if (daysUntil <= daysAhead) {
                    const age = birthday.year ? currentYear - birthday.year : null;
                    return {
                        userId: birthday.userId,
                        displayName: birthday.displayName,
                        username: birthday.username,
                        month: birthday.month,
                        day: birthday.day,
                        year: birthday.year,
                        age,
                        daysUntil,
                    } as BirthdayDisplay & { daysUntil: number };
                }

                return null;
            })
            .filter((birthday): birthday is BirthdayDisplay & { daysUntil: number } => birthday !== null)
            .sort((a, b) => a.daysUntil - b.daysUntil);
    }

    /**
     * Create or update a user's birthday
     */
    async upsert(birthdayData: Omit<NewBirthday, 'createdAt' | 'updatedAt' | 'configVersion'>): Promise<Birthday> {
        const existing = await this.get(birthdayData.guildId, birthdayData.userId);
        const now = new Date().toISOString();

        if (existing) {
            await database
                .updateTable('birthdays')
                .set({
                    ...birthdayData,
                    updatedAt: now,
                })
                .where('guildId', '=', birthdayData.guildId)
                .where('userId', '=', birthdayData.userId)
                .execute();
        } else {
            await database
                .insertInto('birthdays')
                .values({
                    ...birthdayData,
                    createdAt: now,
                    updatedAt: now,
                    configVersion: 1,
                })
                .execute();
        }

        return (await this.get(birthdayData.guildId, birthdayData.userId)) as Birthday;
    }

    /**
     * Delete a user's birthday
     */
    async delete(guildId: string, userId: string): Promise<void> {
        await database.deleteFrom('birthdays').where('guildId', '=', guildId).where('userId', '=', userId).execute();
    }

    /**
     * Update specific fields of a birthday
     */
    async update(
        guildId: string,
        userId: string,
        updates: Omit<BirthdayUpdate, 'guildId' | 'userId' | 'createdAt'>
    ): Promise<void> {
        await database
            .updateTable('birthdays')
            .set({
                ...updates,
                updatedAt: new Date().toISOString(),
            })
            .where('guildId', '=', guildId)
            .where('userId', '=', userId)
            .execute();
    }
}

export const birthdayRepository = new BirthdayRepository();
