import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { database } from '../../../features-system/data-persistence/database';
import { migrateTestDatabase } from '../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import { warningsRepo } from '../../../features/warnings/data/warningsRepo';
import type { AppEnv } from '../../types';

/**
 * `PUT /warnings/{slug}` from a stale edit dialog, end to end below the HTTP layer: the real
 * route, the real `editGuildWarning` and repo, on the migrated in-memory database. Only the
 * mod-log notice is stubbed — it needs a Discord channel.
 *
 * `warningRoutes.test.ts` mocks the logic, so it can only show that a `stale` refusal is
 * forwarded as 409; this shows the refusal is reached and that nothing is written.
 */

const notifyWarningEdited = vi.fn(async () => 'sent' as const);
vi.mock('../../../features/warnings/logic/warningChangeNotices', () => ({
    notifyWarningEdited,
    notifyWarningReleased: vi.fn(),
}));

const { warningRoutes } = await import('../warningRoutes');

const GUILD_ID = 'guild-1';

function put(sessionUserId: string, body: unknown) {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
        c.set('guild', { id: GUILD_ID } as never);
        c.set('user', { id: sessionUserId, username: `mod-${sessionUserId}`, avatar: null, manageableGuildIds: [GUILD_ID] });
        await next();
    });
    app.route('/', warningRoutes());
    return app.request(`/${GUILD_ID}/warnings/consent-k7m2`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

beforeAll(async () => {
    await migrateTestDatabase();
});

beforeEach(async () => {
    vi.clearAllMocks();
    await database.deleteFrom('warnings').execute();
    await warningsRepo.insert({
        guildId: GUILD_ID,
        userId: '400000000000000001',
        userName: 'Kitten',
        issuerId: '300000000000000009',
        issuerName: 'Sir',
        slug: 'consent-k7m2',
        rule: 'Consent',
        description: 'Pushed past a no.',
        issuedAt: '2026-08-01T00:00:00.000Z',
        expiresAt: '2099-02-01T00:00:00.000Z',
        clearedAt: null,
        clearedById: null,
        createdAt: '2026-08-01T00:00:00.000Z',
    });
});

describe('PUT /:guildId/warnings/:slug from a stale dialog', () => {
    it('refuses an edit carrying an old baseEditedAt after another edit, with 409, changing nothing', async () => {
        // Both mods opened the never-edited warning; the first saves.
        const first = await put('300000000000000001', {
            rule: 'Harassment',
            description: 'Pushed past a no.',
            dropsOffOn: '2099-02-01',
            baseEditedAt: null,
        });
        expect(first.status).toBe(200);
        const afterFirst = await warningsRepo.getByGuildAndSlug(GUILD_ID, 'consent-k7m2');

        // The second still holds the form from before the first edit.
        const second = await put('300000000000000002', {
            rule: 'Privacy',
            description: 'Shared a screenshot.',
            dropsOffOn: '2099-06-01',
            baseEditedAt: null,
        });

        expect(second.status).toBe(409);
        expect(((await second.json()) as { error: string }).error).toBe(
            'Somebody else edited this warning while you had it open. Reload it and make your change again.'
        );
        expect(await warningsRepo.getByGuildAndSlug(GUILD_ID, 'consent-k7m2')).toEqual(afterFirst);
        expect(notifyWarningEdited).toHaveBeenCalledOnce();
    });

    it('takes the same edit from a dialog that loaded the first edit', async () => {
        const first = await put('300000000000000001', {
            rule: 'Harassment',
            description: 'Pushed past a no.',
            dropsOffOn: '2099-02-01',
            baseEditedAt: null,
        });
        const loaded = (await first.json()) as { edited: { at: string } };

        const second = await put('300000000000000002', {
            rule: 'Privacy',
            description: 'Shared a screenshot.',
            dropsOffOn: '2099-06-01',
            baseEditedAt: loaded.edited.at,
        });

        expect(second.status).toBe(200);
        expect((await warningsRepo.getByGuildAndSlug(GUILD_ID, 'consent-k7m2'))?.rule).toBe('Privacy');
    });
});
