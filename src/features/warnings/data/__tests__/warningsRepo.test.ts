import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect, sql } from 'kysely';
import type { Database, DatabaseClient } from '../../../../features-system/data-persistence/database';
import { SqlDatePlugin } from '../../../../features-system/data-persistence/plugins/sqlDatePlugin';
import { SqliteBindingPlugin } from '../../../../features-system/data-persistence/plugins/sqliteBindingPlugin';
import {
    calendarDateFromUtcMidnight,
    formatCalendarDate,
    getActiveAsOfUtcMidnight,
    isWarningActive,
} from '../../logic/warningDates';
import { WarningsRepo } from '../warningsRepo';

describe('WarningsRepo active filters (sqlite)', () => {
    const sqlite = new SqliteDatabase(':memory:');
    const db = new Kysely<Database>({
        dialect: new SqliteDialect({
            database: async () => sqlite,
        }),
        plugins: [
            new SqliteBindingPlugin<Database>({}),
            new CamelCasePlugin(),
            new SqlDatePlugin<Database>({
                warnings: ['issuedAt', 'expiresAt', 'clearedAt', 'createdAt'],
            }),
        ],
    }) as DatabaseClient;

    const repo = new WarningsRepo(db);

    beforeAll(async () => {
        await sql`
            CREATE TABLE warnings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guild_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                issuer_id TEXT NOT NULL,
                slug TEXT NOT NULL,
                rule TEXT NOT NULL,
                description TEXT NOT NULL,
                issued_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                cleared_at TEXT,
                cleared_by_id TEXT,
                created_at TEXT NOT NULL
            )
        `.execute(db);
    });

    afterAll(async () => {
        await db.destroy();
    });

    it('lists warnings that are still on or before drop-off and not cleared', async () => {
        const now = new Date('2026-09-01T20:00:00.000Z');
        const asOf = getActiveAsOfUtcMidnight(now);

        await repo.insert({
            guildId: 'guild-1',
            userId: 'user-active',
            issuerId: 'mod-1',
            slug: 'consent-active',
            rule: 'Consent',
            description: 'Active through drop-off day',
            issuedAt: '2026-03-01T00:00:00.000Z',
            expiresAt: '2026-09-01T00:00:00.000Z',
            clearedAt: null,
            clearedById: null,
            createdAt: '2026-03-01T00:00:00.000Z',
        });
        await repo.insert({
            guildId: 'guild-1',
            userId: 'user-expired',
            issuerId: 'mod-1',
            slug: 'consent-expired',
            rule: 'Consent',
            description: 'Dropped off yesterday',
            issuedAt: '2026-02-28T00:00:00.000Z',
            expiresAt: '2026-08-31T00:00:00.000Z',
            clearedAt: null,
            clearedById: null,
            createdAt: '2026-02-28T00:00:00.000Z',
        });
        await repo.insert({
            guildId: 'guild-1',
            userId: 'user-cleared',
            issuerId: 'mod-1',
            slug: 'consent-cleared',
            rule: 'Consent',
            description: 'Cleared early',
            issuedAt: '2026-03-01T00:00:00.000Z',
            expiresAt: '2027-03-01T00:00:00.000Z',
            clearedAt: '2026-08-01T00:00:00.000Z',
            clearedById: 'mod-2',
            createdAt: '2026-03-01T00:00:00.000Z',
        });
        await repo.insert({
            guildId: 'guild-2',
            userId: 'user-other-guild',
            issuerId: 'mod-1',
            slug: 'consent-other',
            rule: 'Consent',
            description: 'Different guild',
            issuedAt: '2026-03-01T00:00:00.000Z',
            expiresAt: '2027-03-01T00:00:00.000Z',
            clearedAt: null,
            clearedById: null,
            createdAt: '2026-03-01T00:00:00.000Z',
        });

        await repo.insert({
            guildId: 'guild-1',
            userId: 'user-active',
            issuerId: 'mod-1',
            slug: 'consent-active-2',
            rule: 'Harassment',
            description: 'Second active warning for the same member',
            issuedAt: '2026-04-01T00:00:00.000Z',
            expiresAt: '2026-10-01T00:00:00.000Z',
            clearedAt: null,
            clearedById: null,
            createdAt: '2026-04-01T00:00:00.000Z',
        });
        await repo.insert({
            guildId: 'guild-1',
            userId: 'user-one',
            issuerId: 'mod-1',
            slug: 'privacy-one',
            rule: 'Privacy',
            description: 'Single warning on a different member',
            issuedAt: '2026-05-01T00:00:00.000Z',
            expiresAt: '2026-12-01T00:00:00.000Z',
            clearedAt: null,
            clearedById: null,
            createdAt: '2026-05-01T00:00:00.000Z',
        });
        await repo.insert({
            guildId: 'guild-1',
            userId: 'user-two-later',
            issuerId: 'mod-1',
            slug: 'consent-later-a',
            rule: 'Consent',
            description: 'Same count as user-active, later soonest drop-off',
            issuedAt: '2026-05-01T00:00:00.000Z',
            expiresAt: '2026-11-01T00:00:00.000Z',
            clearedAt: null,
            clearedById: null,
            createdAt: '2026-05-01T00:00:00.000Z',
        });
        await repo.insert({
            guildId: 'guild-1',
            userId: 'user-two-later',
            issuerId: 'mod-1',
            slug: 'consent-later-b',
            rule: 'Consent',
            description: 'Second warning for the later-expiring pair',
            issuedAt: '2026-06-01T00:00:00.000Z',
            expiresAt: '2027-01-01T00:00:00.000Z',
            clearedAt: null,
            clearedById: null,
            createdAt: '2026-06-01T00:00:00.000Z',
        });

        const active = await repo.listActive('guild-1', asOf, { limit: 10 });
        const count = await repo.countActive('guild-1', asOf);
        const summaries = await repo.listActiveMemberSummaries('guild-1', asOf, 10);
        const memberCount = await repo.countActiveMembers('guild-1', asOf);
        const memberWarnings = await repo.listActive('guild-1', asOf, {
            limit: 10,
            userId: 'user-active',
        });

        expect(active.map((warning) => warning.slug)).toEqual([
            'consent-active',
            'consent-active-2',
            'consent-later-a',
            'privacy-one',
            'consent-later-b',
        ]);
        expect(count).toBe(5);
        expect(memberCount).toBe(3);
        expect(summaries.map((summary) => summary.userId)).toEqual(['user-active', 'user-two-later', 'user-one']);
        expect(summaries[0]).toEqual(
            expect.objectContaining({
                userId: 'user-active',
                warningCount: 2,
            })
        );
        expect(summaries[0].soonestExpiresAt).toBeInstanceOf(Date);
        expect(formatCalendarDate(calendarDateFromUtcMidnight(summaries[0].soonestExpiresAt))).toBe('2026-09-01');
        expect(summaries[1]).toEqual(
            expect.objectContaining({
                userId: 'user-two-later',
                warningCount: 2,
            })
        );
        expect(formatCalendarDate(calendarDateFromUtcMidnight(summaries[1].soonestExpiresAt))).toBe('2026-11-01');
        expect(summaries[2]).toEqual(
            expect.objectContaining({
                userId: 'user-one',
                warningCount: 1,
            })
        );
        expect(memberWarnings.map((warning) => warning.slug)).toEqual(['consent-active', 'consent-active-2']);
        expect(active.every((warning) => isWarningActive(warning, now))).toBe(true);
    });
});
