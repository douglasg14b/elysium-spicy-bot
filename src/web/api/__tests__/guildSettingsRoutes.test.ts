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
};

vi.mock('../../../features-system/guild-settings', () => ({
    guildSettingsRepo: guildSettingsRepoMock,
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

interface SettingsBody {
    staffRoleIds: string[];
    staffRoles: { id: string; name: string }[];
}

interface ErrorBody {
    error: string;
}

beforeEach(() => {
    vi.clearAllMocks();
    guildSettingsRepoMock.getStaffRoleIds.mockResolvedValue([]);
    guildSettingsRepoMock.setStaffRoleIds.mockImplementation(
        (_guildId: string, staffRoleIds: string[]) => Promise.resolve({ staffRoleIds })
    );
});

describe('GET /:guildId/settings', () => {
    it('reports an unconfigured guild as an empty list rather than 404', async () => {
        const response = await getSettings();

        expect(response.status).toBe(200);
        expect((await response.json()) as SettingsBody).toEqual({
            staffRoleIds: [],
            staffRoles: [],
        });
    });

    it('resolves saved ids to role names for display', async () => {
        guildSettingsRepoMock.getStaffRoleIds.mockResolvedValue([STAFF_ROLE]);

        const body = (await (await getSettings()).json()) as SettingsBody;

        expect(body.staffRoleIds).toEqual([STAFF_ROLE]);
        expect(body.staffRoles).toEqual([{ id: STAFF_ROLE, name: 'Staff' }]);
    });

    it('still reports a saved role that has since been deleted', async () => {
        // The id stays in `staffRoleIds` with no matching name. A read must not
        // silently rewrite what was saved — the operator has to be able to see it.
        guildSettingsRepoMock.getStaffRoleIds.mockResolvedValue([STAFF_ROLE, '999999999999999999']);

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
});
