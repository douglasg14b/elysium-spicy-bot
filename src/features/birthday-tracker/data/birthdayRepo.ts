import { database } from '../../../features-system/data-persistence/database';
import { BIRTHDAY_TIMEZONE } from '../../../environment';
import { Birthday, NewBirthday, BirthdayUpdate, BirthdayDisplay } from './birthdaySchema';
import { getDatePartsForTimeZone, getLocalDateKey, isBirthdayCelebratedOnDate } from '../birthdayCelebration';

const BIRTHDAY_ANNOUNCEMENT_START_HOUR = 7;
const BIRTHDAY_ANNOUNCEMENT_END_HOUR = 22;

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
    async getTodaysBirthdays(now: Date = new Date()): Promise<Birthday[]> {
        const dateParts = getDatePartsForTimeZone(now, BIRTHDAY_TIMEZONE);
        const month = dateParts.month;
        const day = dateParts.day;
        const candidateRows =
            month === 2 && day === 28
                ? await database
                      .selectFrom('birthdays')
                      .selectAll()
                      .where('month', '=', 2)
                      .where((expressionBuilder) => expressionBuilder('day', 'in', [28, 29]))
                      .execute()
                : await database
                      .selectFrom('birthdays')
                      .selectAll()
                      .where('month', '=', month)
                      .where('day', '=', day)
                      .execute();

        return candidateRows.filter((birthdayRow) =>
            isBirthdayCelebratedOnDate(birthdayRow.month, birthdayRow.day, now, BIRTHDAY_TIMEZONE)
        );
    }

    /**
     * Get birthdays due for announcement today that have not been announced yet.
     */
    async findDueForAnnouncementToday(now: Date = new Date()): Promise<Birthday[]> {
        if (!isWithinBirthdayAnnouncementWindow(now)) {
            return [];
        }

        const todayBirthdays = await this.getTodaysBirthdays(now);
        const todayDateKey = getLocalDateKey(now, BIRTHDAY_TIMEZONE);

        return todayBirthdays.filter((birthdayRow) => {
            if (!birthdayRow.lastAnnouncedAt) {
                return true;
            }

            return getLocalDateKey(birthdayRow.lastAnnouncedAt, BIRTHDAY_TIMEZONE) !== todayDateKey;
        });
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
    async upsert(
        birthdayData: Omit<NewBirthday, 'createdAt' | 'updatedAt' | 'configVersion' | 'lastAnnouncedAt'>
    ): Promise<Birthday> {
        const existing = await this.get(birthdayData.guildId, birthdayData.userId);
        const now = new Date().toISOString();

        if (existing) {
            const didBirthdayDateChange = existing.month !== birthdayData.month || existing.day !== birthdayData.day;
            await database
                .updateTable('birthdays')
                .set({
                    ...birthdayData,
                    updatedAt: now,
                    lastAnnouncedAt: didBirthdayDateChange ? null : undefined,
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
                    lastAnnouncedAt: null,
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
        const existing = await this.get(guildId, userId);
        const didBirthdayDateChange =
            !!existing &&
            ((updates.month !== undefined && updates.month !== existing.month) ||
                (updates.day !== undefined && updates.day !== existing.day));

        await database
            .updateTable('birthdays')
            .set({
                ...updates,
                lastAnnouncedAt: didBirthdayDateChange ? null : updates.lastAnnouncedAt,
                updatedAt: new Date().toISOString(),
            })
            .where('guildId', '=', guildId)
            .where('userId', '=', userId)
            .execute();
    }

    async markAnnounced(guildId: string, userId: string, at: Date = new Date()): Promise<void> {
        await database
            .updateTable('birthdays')
            .set({
                lastAnnouncedAt: at.toISOString(),
                updatedAt: at.toISOString(),
            })
            .where('guildId', '=', guildId)
            .where('userId', '=', userId)
            .execute();
    }
}

export const birthdayRepository = new BirthdayRepository();

/**
 * Returns true when the current Pacific hour is inside the birthday announcement window.
 * The window starts at 7:00 a.m. and ends before 10:00 p.m.
 */
export function isWithinBirthdayAnnouncementWindow(now: Date = new Date()): boolean {
    const dateParts = getDatePartsForTimeZone(now, BIRTHDAY_TIMEZONE);

    return (
        dateParts.hour >= BIRTHDAY_ANNOUNCEMENT_START_HOUR &&
        dateParts.hour < BIRTHDAY_ANNOUNCEMENT_END_HOUR
    );
}
