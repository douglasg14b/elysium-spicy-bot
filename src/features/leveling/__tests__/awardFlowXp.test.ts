import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client, Guild } from 'discord.js';

/**
 * Awarding XP from a flow.
 *
 * The cases that matter are the two the design turns on, neither of which a type check
 * would catch:
 *
 *   - a flow-awarded level-up **announces** but does **not** notify level-up subscribers,
 *     which is what stops two flows awarding XP on each other's level trigger forever;
 *   - the grant uses activity type `flow`, so it cannot be dropped by, or disturb, the
 *     member's real message and reaction cooldowns.
 */

const getByGuildId = vi.fn();
const grantXp = vi.fn();
const announceLevelUp = vi.fn();
const notifyLevelUp = vi.fn();

vi.mock('../data/levelingConfigRepo', () => ({
    levelingConfigRepo: { getByGuildId: (...args: unknown[]) => getByGuildId(...args) },
}));

vi.mock('../data/levelingProgressRepo', () => ({
    levelingProgressRepo: { grantXp: (...args: unknown[]) => grantXp(...args) },
}));

vi.mock('../levelUpAnnouncer', () => ({
    announceLevelUp: (...args: unknown[]) => announceLevelUp(...args),
}));

/*
 * Mocked so that a future edit wiring the subscriber into this path fails loudly here
 * rather than shipping a feedback loop. Asserting "not called" against a real module
 * would pass just as well, but this way the assertion names the seam.
 */
vi.mock('../levelUpSubscribers', () => ({
    notifyLevelUp: (...args: unknown[]) => notifyLevelUp(...args),
}));

const { awardFlowXp } = await import('../awardFlowXp');

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';

function aGuild(): Guild {
    return { id: GUILD_ID } as unknown as Guild;
}

function input(xpAmount = 100) {
    return {
        client: {} as unknown as Client,
        guild: aGuild(),
        userId: USER_ID,
        xpAmount,
    };
}

/** XP levels come from the real curve, so pick totals far apart enough to cross one. */
function granted(previousTotalXp: number, newTotalXp: number) {
    return { previousTotalXp, newTotalXp };
}

describe('awardFlowXp', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getByGuildId.mockResolvedValue({ enabled: true, notificationChannelId: 'channel-1' });
        grantXp.mockResolvedValue(granted(0, 100));
        announceLevelUp.mockResolvedValue(undefined);
        notifyLevelUp.mockResolvedValue(undefined);
    });

    it('grants the requested XP as flow activity, with no cooldown', async () => {
        const result = await awardFlowXp(input(250));

        expect(result.ok).toBe(true);
        expect(grantXp).toHaveBeenCalledWith(
            expect.objectContaining({
                guildId: GUILD_ID,
                userId: USER_ID,
                xpAmount: 250,
                activityType: 'flow',
                cooldownMs: 0,
            })
        );
    });

    it('does not increment the message, reaction or voice counters', async () => {
        // A flow award is not a message and not a reaction. Counting it as one would
        // misreport the member's activity on every card and ranking that reads those.
        await awardFlowXp(input());

        const grantArgs = grantXp.mock.calls[0]![0] as Record<string, unknown>;
        expect(grantArgs.incrementMessageCount).toBeUndefined();
        expect(grantArgs.incrementReactionCount).toBeUndefined();
        expect(grantArgs.incrementVoiceSessionCount).toBeUndefined();
    });

    it('refuses when leveling is disabled, without granting anything', async () => {
        getByGuildId.mockResolvedValue({ enabled: false, notificationChannelId: '' });

        const result = await awardFlowXp(input());

        expect(result).toEqual({ ok: false, refusal: 'disabled' });
        expect(grantXp).not.toHaveBeenCalled();
    });

    it('refuses when the guild has no leveling config at all', async () => {
        getByGuildId.mockResolvedValue(null);

        const result = await awardFlowXp(input());

        expect(result).toEqual({ ok: false, refusal: 'disabled' });
        expect(grantXp).not.toHaveBeenCalled();
    });

    it.each([0, -50, 1.5, Number.NaN])('refuses %s rather than granting it', async (amount) => {
        const result = await awardFlowXp(input(amount));

        expect(result).toEqual({ ok: false, refusal: 'not-positive' });
        expect(grantXp).not.toHaveBeenCalled();
        // Refused before the config read, so a bad amount costs no query either.
        expect(getByGuildId).not.toHaveBeenCalled();
    });

    describe('when the award crosses a level', () => {
        // 0 → 5000 XP is several levels on any sane curve; the exact count comes from the
        // real `getLevelFromTotalXp`, so the assertions below are about *what happens per
        // level*, not about the curve's shape.
        beforeEach(() => {
            grantXp.mockResolvedValue(granted(0, 5_000));
        });

        it('announces every level crossed', async () => {
            const result = await awardFlowXp(input(5_000));

            expect(result.ok).toBe(true);
            if (!result.ok) return;

            expect(result.newLevel).toBeGreaterThan(result.previousLevel);
            expect(announceLevelUp).toHaveBeenCalledTimes(result.newLevel - result.previousLevel);
        });

        it('never notifies level-up subscribers, so a flow cannot trigger a flow', async () => {
            // The whole reason `awardFlowXp` exists beside `LevelingService.handleLevelUps`
            // rather than reusing it. Two flows — "at level 10, award 500 XP" and "at
            // level 11, award 500 XP" — would otherwise drive each other with nothing in
            // the engine to stop them.
            await awardFlowXp(input(5_000));

            expect(announceLevelUp).toHaveBeenCalled();
            expect(notifyLevelUp).not.toHaveBeenCalled();
        });
    });

    it('announces nothing when the award crosses no level', async () => {
        /*
         * 10 → 20 XP is inside level 1 on the shipped curve, whose first threshold is
         * 155. Asserted as "the level did not change" rather than as `newLevel: 1`, so
         * tuning `getXpThresholdForLevel` cannot make this test fail for a reason that
         * has nothing to do with what it is checking.
         */
        grantXp.mockResolvedValue(granted(10, 20));

        const result = await awardFlowXp(input(10));

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.newLevel).toBe(result.previousLevel);
        expect(result.totalXp).toBe(20);
        expect(announceLevelUp).not.toHaveBeenCalled();
    });
});
