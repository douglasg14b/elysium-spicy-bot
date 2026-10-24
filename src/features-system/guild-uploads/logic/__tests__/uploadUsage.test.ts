import { afterEach, describe, expect, it } from 'vitest';
import {
    clearUploadUsageReadersForTests,
    registerUploadUsageReader,
    uploadUsesForGuild,
    type UploadUse,
} from '../uploadUsage';

/** The reader hook: every registered reader's uses, and a loud failure when there are none. */

function use(uploadId: string, flowId: string): UploadUse {
    return { uploadId, flowId, flowName: 'Flow', nodeId: 'node', blockLabel: 'Post Embed', where: 'embed 1 image' };
}

afterEach(() => {
    clearUploadUsageReadersForTests();
});

describe('uploadUsesForGuild', () => {
    it('fails loudly when no reader is registered, rather than answer "no uses"', async () => {
        await expect(uploadUsesForGuild('guild-1')).rejects.toThrow(/no upload usage reader is registered/);
    });

    it("joins every reader's uses for the guild asked about, in registration order", async () => {
        registerUploadUsageReader(async (guildId) => [use('upload-a', `flows-${guildId}`)]);
        registerUploadUsageReader(async (guildId) => [use('upload-b', `messages-${guildId}`)]);

        expect(await uploadUsesForGuild('guild-1')).toEqual([
            use('upload-a', 'flows-guild-1'),
            use('upload-b', 'messages-guild-1'),
        ]);
    });
});
