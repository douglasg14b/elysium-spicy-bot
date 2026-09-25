import { describe, expect, it } from 'vitest';
import { xpProgress, type XpProgressInput } from '../levelingProgress';

/**
 * The XP bar's arithmetic, including the two inputs that would otherwise render as a
 * layout bug: a level step of zero, and a stored level that has fallen behind its XP.
 */

function input(overrides: Partial<XpProgressInput> = {}): XpProgressInput {
    return {
        level: 7,
        xpWithinLevel: 340,
        xpToNextLevel: 160,
        xpForCurrentLevelStep: 500,
        ...overrides,
    };
}

describe('xpProgress', () => {
    it('computes the percentage the bot itself would draw', () => {
        // 340/500 — the same ratio `getLevelCardProgressRatio` gives the level card, so the
        // dashboard and the card a member posts in chat agree.
        expect(xpProgress(input()).percent).toBe(68);
    });

    it('labels both figures the bar is drawn from', () => {
        const progress = xpProgress(input());

        expect(progress.withinLabel).toBe('340 / 500 XP');
        expect(progress.toNextLabel).toBe('160 XP to level 8');
    });

    it('names the next level, not the current one', () => {
        // The off-by-one that would otherwise tell a level 7 member they need 160 XP to
        // reach level 7.
        expect(xpProgress(input({ level: 1 })).toNextLabel).toBe('160 XP to level 2');
    });

    it('reports 0% when the level table gives the level no span', () => {
        // Matches `getLevelCardProgressRatio`'s `<= 0` guard. Any other answer would be
        // invented, and dividing by it would put `Infinity` into a style attribute.
        expect(xpProgress(input({ xpForCurrentLevelStep: 0 })).percent).toBe(0);
    });

    it('clamps an over-full level to 100% instead of overflowing the track', () => {
        /*
         * Reachable, not hypothetical: the server takes the step from the *stored* level and
         * the progress from `totalXp`, so a row whose level-up write failed reports more XP
         * within the level than the level is worth.
         */
        const progress = xpProgress(input({ xpWithinLevel: 900, xpForCurrentLevelStep: 500 }));

        expect(progress.percent).toBe(100);
    });

    it('stops quoting a remainder once the stored level has fallen behind the XP', () => {
        /*
         * The bug this exists for. `xpToNextLevel` is computed from `totalXp` and the level
         * *it* implies, so on a stalled row it is the remainder to some higher level while
         * `level + 1` names the one after the stored one. Printing it would give an operator a
         * precise, specific, wrong number — worse than naming the state.
         */
        const progress = xpProgress(
            input({ level: 7, xpWithinLevel: 900, xpToNextLevel: 410, xpForCurrentLevelStep: 500 })
        );

        expect(progress.toNextLabel).toBe('ready to level up');
        // Deliberately asserting the absence: "410 XP to level 8" is the wrong answer here.
        expect(progress.toNextLabel).not.toContain('410');
    });

    it('still quotes the remainder on an exactly-full level rather than a stale figure', () => {
        // The boundary: `xpWithinLevel === xpForCurrentLevelStep` is already a level-up owed,
        // so it takes the same branch rather than printing "0 XP to level 8".
        const progress = xpProgress(input({ xpWithinLevel: 500, xpForCurrentLevelStep: 500 }));

        expect(progress.percent).toBe(100);
        expect(progress.toNextLabel).toBe('ready to level up');
    });

    it('does not take the over-full branch when the level table gave no span', () => {
        // A zero step would make `0 >= 0` true and swallow every fresh member into "ready to
        // level up". The `> 0` clause in the guard is what stops that.
        const progress = xpProgress(
            input({ xpWithinLevel: 0, xpForCurrentLevelStep: 0, xpToNextLevel: 155 })
        );

        expect(progress.toNextLabel).toBe('155 XP to level 8');
    });

    it('clamps a negative progress figure to 0%', () => {
        expect(xpProgress(input({ xpWithinLevel: -50 })).percent).toBe(0);
    });

    it('reports 0% for a fresh member with nothing banked', () => {
        const progress = xpProgress(
            input({ level: 1, xpWithinLevel: 0, xpToNextLevel: 155, xpForCurrentLevelStep: 155 })
        );

        expect(progress.percent).toBe(0);
        expect(progress.withinLabel).toBe('0 / 155 XP');
    });
});
