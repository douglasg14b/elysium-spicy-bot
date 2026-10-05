import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../types';

/**
 * The guild settings API contract.
 *
 * `guildRoutes()` is a bare Hono app — auth and guild resolution are applied where it
 * is mounted in `api/index.ts` — so these tests inject a guild directly and focus on
 * what the route itself decides: validation, role existence, and the wire shape.
 *
 * The repo is mocked. Whether the *storage* behaves is settled against real SQL in
 * `guildSettings.integration.test.ts`; duplicating that through HTTP would test
 * SQLite twice and the routing layer once.
 */

const guildSettingsRepoMock = {
    getByGuildId: vi.fn(),
    getStaffRoleIds: vi.fn(),
    setStaffRoleIds: vi.fn(),
    setTimeZone: vi.fn(),
};

// Only the repo module is faked; the barrel's default zone and validator stay real.
vi.mock('../../../features-system/guild-settings/data/guildSettingsRepo', () => ({
    guildSettingsRepo: guildSettingsRepoMock,
    GuildSettingsRepo: class {},
}));

vi.mock('../../../features/warnings/data/warningsConfigRepo', () => ({
    warningsConfigRepo: { getByGuildId: vi.fn(), upsertModChannel: vi.fn() },
}));

vi.mock('../../../features/warnings/logic/setWarningsModChannel', () => ({
    setWarningsModChannel: vi.fn(),
}));

const { guildRoutes } = await import('../guildRoutes');

const GUILD_ID = 'guild-1';
const STAFF_ROLE = '111111111111111111';
const OTHER_ROLE = '222222222222222222';
const MANAGED_ROLE = '444444444444444444';

/**
 * A guild whose role cache holds the two assignable roles above, plus the two kinds
 * of role that must never become staff: `@everyone` (whose id *is* the guild id) and
 * a bot-managed role.
 */
function guildStub() {
    const roles = new Map([
        [STAFF_ROLE, { id: STAFF_ROLE, name: 'Staff', managed: false, position: 5, color: 0 }],
        [OTHER_ROLE, { id: OTHER_ROLE, name: 'Brats', managed: false, position: 3, color: 0 }],
        [GUILD_ID, { id: GUILD_ID, name: '@everyone', managed: false, position: 0, color: 0 }],
        [MANAGED_ROLE, { id: MANAGED_ROLE, name: 'SomeBot', managed: true, position: 4, color: 0 }],
    ]);

    return {
        id: GUILD_ID,
        roles: { cache: roles },
        channels: { cache: new Map() },
    };
}

function app() {
    const outer = new Hono<AppEnv>();
    outer.use('*', async (c, next) => {
        c.set('guild', guildStub() as never);
        await next();
    });
    outer.route('/', guildRoutes());
    return outer;
}

function getSettings() {
    return app().request(`/${GUILD_ID}/settings`);
}

function putSettings(body: unknown) {
    return app().request(`/${GUILD_ID}/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function putTimeZone(body: unknown) {
    return app().request(`/${GUILD_ID}/settings/time-zone`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

interface SettingsBody {
    staffRoleIds: string[];
    staffRoles: { id: string; name: string }[];
    timeZone: string | null;
    defaultTimeZone: string;
}

interface ErrorBody {
    error: string;
}

beforeEach(() => {
    vi.clearAllMocks();
    guildSettingsRepoMock.getByGuildId.mockResolvedValue(null);
    guildSettingsRepoMock.getStaffRoleIds.mockResolvedValue([]);
    // A picked zone, so a staff save that dropped or nulled it on the wire would show.
    guildSettingsRepoMock.setStaffRoleIds.mockImplementation(
        (_guildId: string, staffRoleIds: string[]) => Promise.resolve({ staffRoleIds, timeZone: 'Europe/London' })
    );
    guildSettingsRepoMock.setTimeZone.mockImplementation((_guildId: string, timeZone: string) =>
        Promise.resolve({ staffRoleIds: [STAFF_ROLE], timeZone })
    );
});

describe('GET /:guildId/settings', () => {
    it('reports an unconfigured guild as empty, with no zone picked, rather than 404', async () => {
        const response = await getSettings();

        expect(response.status).toBe(200);
        expect((await response.json()) as SettingsBody).toEqual({
            staffRoleIds: [],
            staffRoles: [],
            timeZone: null,
            defaultTimeZone: 'America/Los_Angeles',
        });
    });

    it('reports a picked zone beside the default', async () => {
        guildSettingsRepoMock.getByGuildId.mockResolvedValue({
            staffRoleIds: [],
            timeZone: 'America/New_York',
        });

        const body = (await (await getSettings()).json()) as SettingsBody;

        expect(body.timeZone).toBe('America/New_York');
        expect(body.defaultTimeZone).toBe('America/Los_Angeles');
    });

    it('resolves saved ids to role names for display', async () => {
        guildSettingsRepoMock.getByGuildId.mockResolvedValue({ staffRoleIds: [STAFF_ROLE], timeZone: null });

        const body = (await (await getSettings()).json()) as SettingsBody;

        expect(body.staffRoleIds).toEqual([STAFF_ROLE]);
        expect(body.staffRoles).toEqual([{ id: STAFF_ROLE, name: 'Staff' }]);
    });

    it('still reports a saved role that has since been deleted', async () => {
        // The id stays in `staffRoleIds` with no matching name. A read must not
        // silently rewrite what was saved — the operator has to be able to see it.
        guildSettingsRepoMock.getByGuildId.mockResolvedValue({
            staffRoleIds: [STAFF_ROLE, '999999999999999999'],
            timeZone: null,
        });

        const body = (await (await getSettings()).json()) as SettingsBody;

        expect(body.staffRoleIds).toHaveLength(2);
        expect(body.staffRoles).toEqual([{ id: STAFF_ROLE, name: 'Staff' }]);
    });
});

describe('PUT /:guildId/settings', () => {
    it('stores roles that exist in the guild', async () => {
        const response = await putSettings({ staffRoleIds: [STAFF_ROLE, OTHER_ROLE] });

        expect(response.status).toBe(200);
        expect(guildSettingsRepoMock.setStaffRoleIds).toHaveBeenCalledWith(GUILD_ID, [
            STAFF_ROLE,
            OTHER_ROLE,
        ]);
    });

    it('rejects a role id that does not exist in the guild, storing nothing', async () => {
        /*
         * The junk-in-the-table guard. A stored id that Discord has never heard of
         * fails much later, during an install, as a permission intent resolving to
         * nothing — far from the form that accepted it.
         */
        const response = await putSettings({ staffRoleIds: [STAFF_ROLE, '999999999999999999'] });

        expect(response.status).toBe(400);
        expect(((await response.json()) as ErrorBody).error).toContain('999999999999999999');
        expect(guildSettingsRepoMock.setStaffRoleIds).not.toHaveBeenCalled();
    });

    it('rejects the whole request when any id is unknown, rather than saving the good ones', async () => {
        // Partial saves would leave the operator with a list they did not ask for and
        // no indication which half landed.
        await putSettings({ staffRoleIds: ['888888888888888888', '999999999999999999'] });

        expect(guildSettingsRepoMock.setStaffRoleIds).not.toHaveBeenCalled();
    });

    it('accepts an empty list as a legal "nobody is staff"', async () => {
        const response = await putSettings({ staffRoleIds: [] });

        expect(response.status).toBe(200);
        expect(guildSettingsRepoMock.setStaffRoleIds).toHaveBeenCalledWith(GUILD_ID, []);
    });

    it('deduplicates before storing, since the list is a set in all but type', async () => {
        await putSettings({ staffRoleIds: [STAFF_ROLE, STAFF_ROLE] });

        expect(guildSettingsRepoMock.setStaffRoleIds).toHaveBeenCalledWith(GUILD_ID, [STAFF_ROLE]);
    });

    it('refuses @everyone, which would make every staff-only channel public', async () => {
        /*
         * The id of `@everyone` is the guild id, so a plain "does this role exist"
         * check accepts it. Compiled, it collides with the `everyone` audience on the
         * same overwrite and erases the deny that makes a channel staff-only — while
         * the plan and dashboard still report it as gated.
         */
        const response = await putSettings({ staffRoleIds: [GUILD_ID] });

        expect(response.status).toBe(400);
        expect(guildSettingsRepoMock.setStaffRoleIds).not.toHaveBeenCalled();
    });

    it('refuses @everyone even when smuggled in beside a legitimate role', async () => {
        const response = await putSettings({ staffRoleIds: [STAFF_ROLE, GUILD_ID] });

        expect(response.status).toBe(400);
        expect(guildSettingsRepoMock.setStaffRoleIds).not.toHaveBeenCalled();
    });

    it('refuses a bot-managed role, which nobody can be granted', async () => {
        const response = await putSettings({ staffRoleIds: [MANAGED_ROLE] });

        expect(response.status).toBe(400);
        expect(guildSettingsRepoMock.setStaffRoleIds).not.toHaveBeenCalled();
    });

    it('lets an operator save past a staff role that was deleted in Discord', async () => {
        /*
         * Validating the whole list would reject this submission forever: the dead id
         * is pre-selected from the saved list and the operator cannot re-create the
         * role. Only newly added ids are checked, so the save goes through and the
         * dead id can be pruned.
         */
        const DELETED = '999999999999999999';
        guildSettingsRepoMock.getStaffRoleIds.mockResolvedValue([STAFF_ROLE, DELETED]);

        const response = await putSettings({ staffRoleIds: [STAFF_ROLE, DELETED] });

        expect(response.status).toBe(200);
        expect(guildSettingsRepoMock.setStaffRoleIds).toHaveBeenCalled();
    });

    it('lets that dead role be dropped', async () => {
        const DELETED = '999999999999999999';
        guildSettingsRepoMock.getStaffRoleIds.mockResolvedValue([STAFF_ROLE, DELETED]);

        await putSettings({ staffRoleIds: [STAFF_ROLE] });

        expect(guildSettingsRepoMock.setStaffRoleIds).toHaveBeenCalledWith(GUILD_ID, [STAFF_ROLE]);
    });

    it('rejects a body that is not a list of ids', async () => {
        const response = await putSettings({ staffRoleIds: 'staff' });

        expect(response.status).toBe(400);
        expect(guildSettingsRepoMock.setStaffRoleIds).not.toHaveBeenCalled();
    });

    it('rejects a missing body outright', async () => {
        const response = await putSettings({});

        expect(response.status).toBe(400);
        expect(guildSettingsRepoMock.setStaffRoleIds).not.toHaveBeenCalled();
    });

    it('never writes the time zone, and answers with the one saved', async () => {
        // A staff-only form must not be able to touch a setting it does not show — nor
        // drop it from the response, which the page takes as the new saved state.
        const response = await putSettings({ staffRoleIds: [STAFF_ROLE], timeZone: 'UTC' });

        expect(guildSettingsRepoMock.setTimeZone).not.toHaveBeenCalled();
        expect(((await response.json()) as SettingsBody).timeZone).toBe('Europe/London');
    });
});

describe('PUT /:guildId/settings/time-zone', () => {
    it('stores a zone and answers with the whole settings shape', async () => {
        const response = await putTimeZone({ timeZone: 'America/New_York' });

        expect(response.status).toBe(200);
        expect(guildSettingsRepoMock.setTimeZone).toHaveBeenCalledWith(GUILD_ID, 'America/New_York');
        expect(guildSettingsRepoMock.setStaffRoleIds).not.toHaveBeenCalled();
        expect((await response.json()) as SettingsBody).toEqual({
            staffRoleIds: [STAFF_ROLE],
            staffRoles: [{ id: STAFF_ROLE, name: 'Staff' }],
            timeZone: 'America/New_York',
            defaultTimeZone: 'America/Los_Angeles',
        });
    });

    it('accepts UTC, which the runtime leaves out of its own zone list', async () => {
        const response = await putTimeZone({ timeZone: 'UTC' });

        expect(response.status).toBe(200);
        expect(guildSettingsRepoMock.setTimeZone).toHaveBeenCalledWith(GUILD_ID, 'UTC');
    });

    it('tidies a hand-typed spelling that differs only in case', async () => {
        await putTimeZone({ timeZone: 'utc' });

        expect(guildSettingsRepoMock.setTimeZone).toHaveBeenCalledWith(GUILD_ID, 'UTC');
    });

    it("stores the operator's modern spelling, not the runtime's legacy one", async () => {
        // Node canonicalises this to `Asia/Calcutta`; the operator picked Kolkata.
        const response = await putTimeZone({ timeZone: 'Asia/Kolkata' });

        expect(response.status).toBe(200);
        expect(guildSettingsRepoMock.setTimeZone).toHaveBeenCalledWith(GUILD_ID, 'Asia/Kolkata');
    });

    it('refuses a zone Intl has never heard of, storing nothing', async () => {
        const response = await putTimeZone({ timeZone: 'Mars/Olympus_Mons' });

        expect(response.status).toBe(400);
        expect(((await response.json()) as ErrorBody).error).toContain('Mars/Olympus_Mons');
        expect(guildSettingsRepoMock.setTimeZone).not.toHaveBeenCalled();
    });

    it('refuses a raw offset, which is not a zone', async () => {
        const response = await putTimeZone({ timeZone: '+05:00' });

        expect(response.status).toBe(400);
        expect(guildSettingsRepoMock.setTimeZone).not.toHaveBeenCalled();
    });

    it('refuses an empty, missing or absurdly long zone', async () => {
        expect((await putTimeZone({ timeZone: '' })).status).toBe(400);
        expect((await putTimeZone({})).status).toBe(400);
        expect((await putTimeZone({ timeZone: 'America/'.repeat(20) })).status).toBe(400);
        expect(guildSettingsRepoMock.setTimeZone).not.toHaveBeenCalled();
    });
});
