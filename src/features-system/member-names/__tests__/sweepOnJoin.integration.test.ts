import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TestDiscord } from '../../../shared/__tests__/support/testDiscord';
import { migrateTestDatabase } from '../../data-persistence/__tests__/support/migrateTestDatabase';
import { memberNamesRepo } from '../data/memberNamesRepo';
import { watchMemberNames } from '../initMemberNames';

/**
 * A server the bot joins while running is swept like the ones it started in, through the
 * same one-at-a-time path. Its own file and client, with no allowlist (every server
 * allowed): the joined server's id does not exist until it is joined.
 */

const discord = new TestDiscord();

beforeAll(async () => {
    await migrateTestDatabase();
    const client = await discord.start();
    watchMemberNames(client, []);
});

afterAll(async () => {
    await discord.destroy();
});

describe('a server joined while running', () => {
    it('is swept: its members are recorded', async () => {
        const joined = discord.createGuild();

        await vi.waitFor(async () => {
            const [bot] = await memberNamesRepo.findByUserIds(joined.id, [joined.bot.id]);
            expect(bot).toMatchObject({ isBot: true, inServer: true });
        });
    });
});
