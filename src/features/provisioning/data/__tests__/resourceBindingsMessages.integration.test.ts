import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProvisioningTestDb } from '../../__tests__/support/provisioningTestDb';

/**
 * A message row's compare-and-set writes, against real SQL: each is scoped to the post the
 * caller read, so an install that reposted onto the same row in between is never written
 * over with a fingerprint, or a forget, meant for the post before it.
 */

const testDb = await createProvisioningTestDb();

vi.mock('../../../../features-system/data-persistence/database', () => ({
    get database() {
        return testDb.db;
    },
}));

const { resourceBindingsRepo } = await import('../resourceBindingsRepo');

const GUILD = 'guild-1';
const JOURNEY = 'house';
const PANEL = 'rules-panel';

beforeEach(async () => {
    await testDb.db.deleteFrom('resource_bindings').execute();
});

afterAll(async () => {
    await testDb.db.destroy();
});

/** Post the panel as `discordId`, as install records it, and hand back its row id. */
async function post(discordId: string, digest: string): Promise<number> {
    await resourceBindingsRepo.upsertPostedMessage({
        guildId: GUILD,
        journeyKey: JOURNEY,
        resourceKey: PANEL,
        discordId,
        channelId: 'channel-1',
        digest,
        name: 'Rules panel',
    });
    const row = await resourceBindingsRepo.get(GUILD, JOURNEY, PANEL);
    if (!row) throw new Error('upsertPostedMessage recorded no row.');
    return row.id;
}

describe('recordMessageDigest', () => {
    it('records the fingerprint while the row still names the post it was given', async () => {
        const id = await post('message-1', 'digest-posted');

        await expect(
            resourceBindingsRepo.recordMessageDigest({ id, expectedDiscordId: 'message-1', digest: 'digest-repaired' })
        ).resolves.toBe(true);
        expect((await resourceBindingsRepo.get(GUILD, JOURNEY, PANEL))?.messageDigest).toBe('digest-repaired');
    });

    it('writes nothing, and says so, once the row has moved on to another post', async () => {
        const id = await post('message-1', 'digest-posted');
        // An install posted it again meanwhile, onto the same row.
        await post('message-2', 'digest-reposted');

        await expect(
            resourceBindingsRepo.recordMessageDigest({ id, expectedDiscordId: 'message-1', digest: 'digest-repaired' })
        ).resolves.toBe(false);
        expect(await resourceBindingsRepo.get(GUILD, JOURNEY, PANEL)).toMatchObject({
            id,
            discordId: 'message-2',
            messageDigest: 'digest-reposted',
        });
    });
});
