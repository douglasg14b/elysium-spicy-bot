import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { createBirthdayAnnouncementWriter } from '../birthdayAnnouncementWriter';

const USAGE = {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function modelReplying(text: string) {
    return new MockLanguageModelV4({
        doGenerate: async () => ({
            content: [{ type: 'text' as const, text }],
            finishReason: { unified: 'stop' as const, raw: undefined },
            usage: USAGE,
            warnings: [],
        }),
    });
}

describe('birthdayAnnouncementWriter', () => {
    it("writes from the member's recent messages and the retry's reasons, in the persona, trimmed", async () => {
        const model = modelReplying('  Another lap around the sun. Make it count.  ');
        const writer = createBirthdayAnnouncementWriter(model);

        const announcement = await writer.writeAnnouncement({
            displayName: 'Avery',
            username: 'avery_irl',
            contextualMessages: ['just finished painting minis', 'dice goblin hours'],
            retryFeedback: 'Violations:\n- output must not include "Avery"',
        });

        expect(announcement).toBe('Another lap around the sun. Make it count.');
        const prompt = model.doGenerateCalls[0]?.prompt ?? [];
        expect(prompt[0]).toMatchObject({ role: 'system', content: expect.stringContaining('You are BrattyBot.') });
        const said = JSON.stringify(prompt.slice(1));
        expect(said.indexOf('just finished painting minis')).toBeLessThan(said.indexOf('dice goblin hours'));
        expect(said).toContain('displayName=\\"Avery\\"');
        expect(said).toContain('Your previous attempt was rejected');
        expect(said).toContain('output must not include');
    });

    it('throws on an empty answer, so the service falls back', async () => {
        const writer = createBirthdayAnnouncementWriter(modelReplying('   '));
        await expect(writer.writeAnnouncement({ displayName: 'J', username: 'j_online' })).rejects.toThrow(/empty/);
    });
});
