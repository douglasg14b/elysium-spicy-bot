import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../../data-persistence/database';
import { up as createGuildSettings } from '../../../data-persistence/migrations/2026-09-21-Create_Guild_Settings';
import { up as addGuildTimeZone } from '../../../data-persistence/migrations/2026-10-04-Guild_Settings_Time_Zone';
import { SqliteJsonPlugin } from '../../../data-persistence/plugins/sqliteJsonPlugin';
import { GuildSettingsRepo } from '../guildSettingsRepo';

/**
 * The guild settings repo against real SQL.
 *
 * The questions here cannot be answered by a mock: whether the role list actually
 * survives the JSON column, whether the unique index really keeps one row per guild
 * across repeated writes, and whether an unconfigured guild reads as empty rather
 * than throwing. Each has a real failure mode a stubbed repo would report as passing
 * — the JSON one especially, since it is a live dialect divergence elsewhere in this
 * schema.
 *
 * Runs the migration's own sqlite arm, so the schema under test is the one that ships.
 */

let db: Kysely<any>;
let repo: GuildSettingsRepo;

const GUILD = 'guild-1';
const OTHER_GUILD = 'guild-2';

beforeAll(async () => {
    db = new Kysely<any>({
        dialect: new SqliteDialect({ database: new SqliteDatabase(':memory:') }),
        // Mirrors the production client for this table: the JSON plugin parses
        // `staff_role_ids` back into an array, and CamelCasePlugin must follow it in
        // the same relative order the app uses.
        plugins: [
            new SqliteJsonPlugin<any>({ guild_settings: ['staffRoleIds'] }),
            new CamelCasePlugin(),
        ],
    });

    process.env.DB_TYPE = 'sqlite';
    await createGuildSettings(db);
    await addGuildTimeZone(db);

    repo = new GuildSettingsRepo(db as unknown as DatabaseClient);
});

afterAll(async () => {
    await db.destroy();
});

beforeEach(async () => {
    await db.deleteFrom('guild_settings').execute();
});

describe('GuildSettingsRepo', () => {
    it('round-trips a staff role list through the JSON column unchanged', async () => {
        const roleIds = ['111111111111111111', '222222222222222222'];

        await repo.setStaffRoleIds(GUILD, roleIds);
        const saved = await repo.getByGuildId(GUILD);

        expect(saved).not.toBeNull();
        // An array, not the JSON string it is stored as. This is the assertion that
        // catches the sqlite/postgres divergence if the plugin registration is lost.
        expect(saved?.staffRoleIds).toEqual(roleIds);
        expect(Array.isArray(saved?.staffRoleIds)).toBe(true);
    });

    it('reads an unconfigured guild as no settings rather than throwing', async () => {
        expect(await repo.getByGuildId(GUILD)).toBeNull();
    });

    it('reports no staff roles for a guild that has never been configured', async () => {
        // Empty is a real answer the install path depends on: it means "no staff
        // configured", and must never be confused with "everyone".
        expect(await repo.getStaffRoleIds(GUILD)).toEqual([]);
    });

    it('replaces the list wholesale rather than appending to it', async () => {
        await repo.setStaffRoleIds(GUILD, ['111111111111111111', '222222222222222222']);
        await repo.setStaffRoleIds(GUILD, ['333333333333333333']);

        expect(await repo.getStaffRoleIds(GUILD)).toEqual(['333333333333333333']);
    });

    it('keeps one row per guild across repeated writes', async () => {
        await repo.setStaffRoleIds(GUILD, ['111111111111111111']);
        await repo.setStaffRoleIds(GUILD, ['222222222222222222']);
        await repo.setStaffRoleIds(GUILD, ['333333333333333333']);

        const rows = await db.selectFrom('guild_settings').selectAll().execute();
        // The unique index is what makes the read-then-write upsert safe. Two rows
        // here would mean reads start returning whichever came back first.
        expect(rows).toHaveLength(1);
    });

    it('clears the list when given an empty one', async () => {
        await repo.setStaffRoleIds(GUILD, ['111111111111111111']);
        await repo.setStaffRoleIds(GUILD, []);

        // Distinct from never-configured at the row level, identical at the read the
        // install path uses — deliberately, since both mean "no staff to grant".
        expect(await repo.getByGuildId(GUILD)).not.toBeNull();
        expect(await repo.getStaffRoleIds(GUILD)).toEqual([]);
    });

    it('keeps each guild\'s settings to itself', async () => {
        await repo.setStaffRoleIds(GUILD, ['111111111111111111']);
        await repo.setStaffRoleIds(OTHER_GUILD, ['999999999999999999']);

        expect(await repo.getStaffRoleIds(GUILD)).toEqual(['111111111111111111']);
        expect(await repo.getStaffRoleIds(OTHER_GUILD)).toEqual(['999999999999999999']);
    });

    it('stamps the config version every other config table here carries', async () => {
        await repo.setStaffRoleIds(GUILD, ['111111111111111111']);
        const saved = await repo.getByGuildId(GUILD);

        expect(saved?.configVersion).toBe(1);
    });
});

describe('GuildSettingsRepo time zone', () => {
    it('reads an unconfigured guild as not chosen, running on Pacific', async () => {
        expect(await repo.getTimeZone(GUILD)).toEqual({
            chosen: null,
            effective: 'America/Los_Angeles',
        });
    });

    it('round-trips a picked zone', async () => {
        await repo.setTimeZone(GUILD, 'America/New_York');

        expect(await repo.getTimeZone(GUILD)).toEqual({
            chosen: 'America/New_York',
            effective: 'America/New_York',
        });
    });

    it('creates the row with no staff roles when the time zone is the first setting saved', async () => {
        await repo.setTimeZone(GUILD, 'UTC');

        // An array, not the `'[]'` string the insert wrote: the JSON plugin still
        // parses a row the staff form never touched.
        expect(await repo.getStaffRoleIds(GUILD)).toEqual([]);
        expect((await repo.getByGuildId(GUILD))?.configVersion).toBe(1);
    });

    it('leaves the time zone unpicked on a row created by the staff form', async () => {
        await repo.setStaffRoleIds(GUILD, ['111111111111111111']);

        expect((await repo.getTimeZone(GUILD)).chosen).toBeNull();
    });

    it('changes a picked zone without adding a row', async () => {
        await repo.setTimeZone(GUILD, 'America/New_York');
        await repo.setTimeZone(GUILD, 'Europe/London');

        expect((await repo.getTimeZone(GUILD)).chosen).toBe('Europe/London');
        expect(await db.selectFrom('guild_settings').selectAll().execute()).toHaveLength(1);
    });

    /*
     * The clobber guard, both ways. The two settings are saved by two forms through two
     * routes; a write that sets the whole row would wipe whichever setting its form does
     * not show, and nothing on screen would say so until a flow ran at the wrong hour or
     * a staff channel opened to nobody.
     */
    it('saving staff roles keeps the picked time zone', async () => {
        await repo.setTimeZone(GUILD, 'America/New_York');
        await repo.setStaffRoleIds(GUILD, ['111111111111111111']);

        expect((await repo.getTimeZone(GUILD)).chosen).toBe('America/New_York');
    });

    it('saving the time zone keeps the staff roles', async () => {
        await repo.setStaffRoleIds(GUILD, ['111111111111111111', '222222222222222222']);
        await repo.setTimeZone(GUILD, 'America/New_York');

        expect(await repo.getStaffRoleIds(GUILD)).toEqual(['111111111111111111', '222222222222222222']);
    });

    it('lets both forms be the first to save at once, keeping both settings in one row', async () => {
        // Two Save buttons on one page: on a guild with no row, both writes can find
        // no row and insert. The second must land as an update, not a unique-index error.
        await Promise.all([
            repo.setStaffRoleIds(GUILD, ['111111111111111111']),
            repo.setTimeZone(GUILD, 'America/New_York'),
        ]);

        expect(await repo.getStaffRoleIds(GUILD)).toEqual(['111111111111111111']);
        expect((await repo.getTimeZone(GUILD)).chosen).toBe('America/New_York');
        expect(await db.selectFrom('guild_settings').selectAll().execute()).toHaveLength(1);
    });
});
