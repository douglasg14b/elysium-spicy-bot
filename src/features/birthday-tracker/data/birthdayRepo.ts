import { database } from '../../../features-system/data-persistence/database';
import { Birthday, NewBirthday, BirthdayUpdate, BirthdayDisplay } from './birthdaySchema';
import {
    getDbMatchPairsForToday,
    isBirthdayCelebratedToday,
    wasAnnouncedOnSameLocalDayAsNow,
} from '../birthdayCelebration';

export type AnnouncementClaimResult =
    | {
          claimed: true;
          claimAt: Date;
          previousLastAnnouncedAt: Date | null;
      }
    | { claimed: false };

function numUpdatedIsOne(numUpdatedRows: bigint | number | undefined): boolean {
    if (numUpdatedRows === undefined) {
        return false;
    }
    const n = typeof numUpdatedRows === 'bigint' ? numUpdatedRows : BigInt(numUpdatedRows);
    return n === 1n;
}

export type BirthdayUpsertInput = Omit<
    NewBirthday,
    'createdAt' | 'updatedAt' | 'configVersion' | 'lastAnnouncedAt' | 'id'
>;

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

        return birthday ?? null;
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
     * Get birthdays for today across all guilds (local process timezone + leap-year observation).
     */
    async getTodaysBirthdays(): Promise<Birthday[]> {
        const now = new Date();
        const pairs = getDbMatchPairsForToday(now);
        const candidates = await database
            .selectFrom('birthdays')
            .selectAll()
            .where((eb) => eb.or(pairs.map(([month, day]) => eb.and([eb('month', '=', month), eb('day', '=', day)]))))
            .execute();

        return candidates.filter((row) => isBirthdayCelebratedToday(row.month, row.day, now));
    }

    /**
     * Birthdays that should receive a public announcement today and have not yet been announced today (local celebration day).
     */
    async findDueForAnnouncementToday(): Promise<Birthday[]> {
        const now = new Date();
        const pairs = getDbMatchPairsForToday(now);
        const candidates = await database
            .selectFrom('birthdays')
            .selectAll()
            .where((eb) => eb.or(pairs.map(([month, day]) => eb.and([eb('month', '=', month), eb('day', '=', day)]))))
            .execute();

        return candidates.filter((row) => {
            if (!isBirthdayCelebratedToday(row.month, row.day, now)) {
                return false;
            }
            if (!row.lastAnnouncedAt) {
                return true;
            }
            return !wasAnnouncedOnSameLocalDayAsNow(row.lastAnnouncedAt, now);
        });
    }

    async markAnnounced(guildId: string, userId: string, at: Date = new Date()): Promise<void> {
        await database
            .updateTable('birthdays')
            .set({
                lastAnnouncedAt: at.toISOString(),
                updatedAt: new Date().toISOString(),
            })
            .where('guildId', '=', guildId)
            .where('userId', '=', userId)
            .execute();
    }

    /**
     * Atomically reserves the announcement slot for this local celebration day (process timezone)
     * if the row is still due. Losers of a cross-process race get `claimed: false` and must not post.
     * Call {@link BirthdayRepository.revertAnnouncementClaim} if {@link TextChannel.send} fails afterward.
     */
    async claimAnnouncementIfDue(guildId: string, userId: string, now: Date = new Date()): Promise<AnnouncementClaimResult> {
        const row = await this.get(guildId, userId);
        if (!row) {
            return { claimed: false };
        }
        if (!isBirthdayCelebratedToday(row.month, row.day, now)) {
            return { claimed: false };
        }
        if (row.lastAnnouncedAt && wasAnnouncedOnSameLocalDayAsNow(row.lastAnnouncedAt, now)) {
            return { claimed: false };
        }

        const claimAt = new Date();
        const updatedAt = new Date().toISOString();
        const claimIso = claimAt.toISOString();
        const previous = row.lastAnnouncedAt;

        const updateBase = database
            .updateTable('birthdays')
            .set({
                lastAnnouncedAt: claimIso,
                updatedAt,
            })
            .where('guildId', '=', guildId)
            .where('userId', '=', userId);

        const result =
            previous === null || previous === undefined
                ? await updateBase.where('lastAnnouncedAt', 'is', null).executeTakeFirst()
                : await updateBase.where('lastAnnouncedAt', '=', new Date(previous)).executeTakeFirst();

        if (!numUpdatedIsOne(result.numUpdatedRows)) {
            return { claimed: false };
        }

        return {
            claimed: true,
            claimAt,
            previousLastAnnouncedAt: previous ?? null,
        };
    }

    /**
     * Restores `last_announced_at` after a failed send, only if it still matches the claim timestamp
     * (avoids clobbering another writer).
     */
    async revertAnnouncementClaim(
        guildId: string,
        userId: string,
        claimAt: Date,
        previousLastAnnouncedAt: Date | null
    ): Promise<void> {
        await database
            .updateTable('birthdays')
            .set({
                lastAnnouncedAt: previousLastAnnouncedAt ? previousLastAnnouncedAt.toISOString() : null,
                updatedAt: new Date().toISOString(),
            })
            .where('guildId', '=', guildId)
            .where('userId', '=', userId)
            .where('lastAnnouncedAt', '=', claimAt)
            .executeTakeFirst();
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
    async upsert(birthdayData: BirthdayUpsertInput): Promise<Birthday> {
        const existing = await this.get(birthdayData.guildId, birthdayData.userId);
        const now = new Date().toISOString();

        const monthDayChanged =
            !!existing && (existing.month !== birthdayData.month || existing.day !== birthdayData.day);

        if (existing) {
            await database
                .updateTable('birthdays')
                .set({
                    ...birthdayData,
                    updatedAt: now,
                    ...(monthDayChanged ? { lastAnnouncedAt: null } : {}),
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
        const existing = await this.get(guildId, userId);
        let clearLastAnnounced = false;
        if (existing) {
            if (updates.month !== undefined && updates.month !== existing.month) {
                clearLastAnnounced = true;
            }
            if (updates.day !== undefined && updates.day !== existing.day) {
                clearLastAnnounced = true;
            }
        }

        await database
            .updateTable('birthdays')
            .set({
                ...updates,
                updatedAt: new Date().toISOString(),
                ...(clearLastAnnounced ? { lastAnnouncedAt: null } : {}),
            })
            .where('guildId', '=', guildId)
            .where('userId', '=', userId)
            .execute();
    }
}

export const birthdayRepository = new BirthdayRepository();
