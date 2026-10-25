import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceDeclaration } from '../resourceDeclaration';
import { createProvisioningTestDb } from '../../__tests__/support/provisioningTestDb';

/**
 * Provisioning's upload usage reader, over real journeys rows: every place a declared
 * message resource shows an upload, for one guild only. The 409 it makes possible is
 * asserted through the delete route in `uploadRoutes.test.ts`.
 */

const testDb = await createProvisioningTestDb();

vi.mock('../../../../features-system/data-persistence/database', () => ({
    get database() {
        return testDb.db;
    },
}));

const { journeyMessageUploadUses } = await import('../journeyMessageUploadUses');
const { journeysRepo } = await import('../../data/journeysRepo');

const LOGO = '0f0e0d0c-0b0a-4908-8706-050403020100';
const BANNER = '1f1e1d1c-1b1a-4918-8716-151413121110';

function panel(uploadIds: { readonly icon: string; readonly image: string }): ResourceDeclaration[] {
    return [
        { key: 'rules', kind: 'textChannel', defaultName: 'rules' },
        {
            key: 'rules-panel',
            kind: 'message',
            defaultName: 'Rules panel',
            parentKey: 'rules',
            message: {
                embeds: [
                    { title: 'House rules', author: { name: 'Mgmt', iconUrl: `upload:${uploadIds.icon}` } },
                    { title: 'Banner', image: `upload:${uploadIds.image}`, thumbnail: 'https://example.com/a.png' },
                ],
            },
        },
    ];
}

beforeEach(async () => {
    await testDb.db.deleteFrom('journeys').execute();
});

afterAll(async () => {
    await testDb.db.destroy();
});

describe('journeyMessageUploadUses', () => {
    it("finds a journey message's header icon and image, named by journey, message and part", async () => {
        await journeysRepo.create({ guildId: 'guild-1', journeyKey: 'onboarding', name: 'Onboarding', resources: panel({ icon: LOGO, image: BANNER }) });

        const at = { kind: 'journeyMessage', journeyKey: 'onboarding', journeyName: 'Onboarding', resourceKey: 'rules-panel', messageName: 'Rules panel' };
        expect(await journeyMessageUploadUses('guild-1')).toEqual([
            { ...at, uploadId: LOGO, where: 'embed 1 header icon' },
            { ...at, uploadId: BANNER, where: 'embed 2 image' },
        ]);
    });

    it("ignores another guild's journey, even one showing the same upload", async () => {
        await journeysRepo.create({ guildId: 'guild-2', journeyKey: 'onboarding', name: 'Theirs', resources: panel({ icon: LOGO, image: LOGO }) });

        expect(await journeyMessageUploadUses('guild-1')).toEqual([]);
    });

    it('finds nothing in a journey without messages', async () => {
        await journeysRepo.create({
            guildId: 'guild-1',
            journeyKey: 'plain',
            name: 'Plain',
            resources: [{ key: 'rules', kind: 'textChannel', defaultName: 'rules' }],
        });

        expect(await journeyMessageUploadUses('guild-1')).toEqual([]);
    });
});
