import { Migrator, sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { activityEventsRepo, type RecordActivityEventInput } from '../../activity/data/activityEventsRepo';
import { database } from '../database';
import { FileMigrationProvider } from '../fileMigrationProvider';
import { migrateTestDatabase } from './support/migrateTestDatabase';

/**
 * `2026-10-02-Activity_Backfill` on SQLite, through a real `Migrator` — down and back up,
 * since the migrator hands the sqlite arm no transaction and it opens its own.
 *
 * Postgres is not covered here: CI runs SQLite only, so the postgres arm was live-run
 * against a throwaway `postgres:16` when it was written.
 */

const BEFORE = '2026-10-01-Record_Activity_Thread_Parents';

const migrator = new Migrator({ db: database, provider: new FileMigrationProvider() });

async function migrateOrThrow(run: Promise<{ error?: unknown }>): Promise<void> {
    const { error } = await run;
    if (error) throw error;
}

async function tableNames(): Promise<string[]> {
    const { rows } = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`.execute(database);
    return rows.map((row) => row.name);
}

async function activityEventColumns(): Promise<string[]> {
    const { rows } = await sql<{ name: string }>`SELECT name FROM pragma_table_info('activity_events')`.execute(database);
    return rows.map((row) => row.name);
}

function aReaction(overrides: Partial<RecordActivityEventInput> = {}): RecordActivityEventInput {
    return {
        guildId: 'guild-1',
        userId: 'user-1',
        channelId: 'channel-1',
        parentChannelId: null,
        messageId: null,
        kind: 'reaction',
        occurredAt: new Date('2026-10-02T09:00:00.000Z'),
        ...overrides,
    };
}

beforeAll(async () => {
    await migrateTestDatabase();
});

describe('2026-10-02-Activity_Backfill (sqlite, through Migrator)', () => {
    it('lets any number of rows hold no message id, and only one hold each id', async () => {
        expect(await activityEventsRepo.record(aReaction())).not.toBeNull();
        expect(await activityEventsRepo.record(aReaction())).not.toBeNull();

        const message = aReaction({ kind: 'message', messageId: '1424000000000000000' });
        expect(await activityEventsRepo.record(message)).not.toBeNull();
        expect(await activityEventsRepo.record(message)).toBeNull();
    });

    it('goes down to the schema before it, and back up', async () => {
        await migrateOrThrow(migrator.migrateTo(BEFORE));

        expect(await tableNames()).not.toContain('activity_recorder_sessions');
        expect(await activityEventColumns()).not.toContain('message_id');

        await migrateOrThrow(migrator.migrateToLatest());

        expect(await tableNames()).toContain('activity_recorder_sessions');
        expect(await activityEventColumns()).toContain('message_id');
    });
});
