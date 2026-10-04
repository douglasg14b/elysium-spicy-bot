/**
 * The XP bar and the label under it, derived once from the detail response.
 *
 * `xpWithinLevel / xpForCurrentLevelStep` is the bot's own ratio — `levelCardProgress.ts`
 * and `formatXpProgressBar` both compute it that way — so the dashboard agrees with the
 * level card a member can post in chat. Computed here rather than in JSX because the
 * division has degenerate inputs that no `.tsx` in this repo could have a test for.
 */

import type { LevelingUserDetail } from '@brattybot/web-sdk';

/** The members of the detail response the bar is actually drawn from. */
export type XpProgressInput = Pick<
    LevelingUserDetail,
    'level' | 'xpWithinLevel' | 'xpToNextLevel' | 'xpForCurrentLevelStep'
>;

export interface XpProgress {
    /** 0–100, already clamped and rounded. Feeds Mantine's `Progress value`. */
    readonly percent: number;
    /** `340 / 500 XP` — the two numbers the bar is drawn from. */
    readonly withinLabel: string;
    /** `160 XP to level 8`, or a shape rather than a figure when the two disagree. */
    readonly toNextLabel: string;
}

/**
 * The bar and its labels.
 *
 * **Clamped in both directions, and the upper clamp is reachable.** The server takes
 * `xpForCurrentLevelStep` from the *stored* `progress.level` while `xpWithinLevel` and
 * `xpToNextLevel` are recomputed from `totalXp`, so a progress row whose level has fallen
 * behind its XP — a failed level-up write, a hand-edited row, a curve change — yields a
 * ratio above 1. Clamped rather than rendered, because a bar past its own track is a
 * layout bug to look at and the disagreement is the bot's to reconcile, not the browser's.
 *
 * A zero or negative step yields 0%, matching `getLevelCardProgressRatio`: it means the
 * level table gave this level no span to fill, so any other answer would be invented.
 *
 * **The remainder is dropped when the pair disagrees, rather than clamped.** `xpToNextLevel`
 * is `getXpToNextLevel(totalXp)`, which re-derives the level from the XP internally — so it
 * is always positive, and it is a remainder for the level the *XP* implies, not the one
 * `level` holds. A clamp would therefore never fire, and the un-clamped figure is worse than
 * a negative one would be: for a row stuck at level 7 holding level-9 XP it prints a precise
 * "410 XP to level 8" that is actually the remainder to level 10. Better to say the shape.
 *
 * There is no ceiling case. `getXpThresholdForLevel` is `5L² + 50L + 100` — unbounded — so
 * there is always a next level to name.
 */
export function xpProgress(detail: XpProgressInput): XpProgress {
    const { level, xpWithinLevel, xpToNextLevel, xpForCurrentLevelStep } = detail;

    const ratio =
        xpForCurrentLevelStep > 0
            ? Math.min(Math.max(xpWithinLevel / xpForCurrentLevelStep, 0), 1)
            : 0;

    /*
     * The stored level has fallen behind the banked XP. Reachable: a failed level-up write, a
     * hand-edited row, a curve change. The bar saturates and the sentence stops quoting a
     * number that belongs to a different level.
     */
    const overFull = xpForCurrentLevelStep > 0 && xpWithinLevel >= xpForCurrentLevelStep;

    return {
        percent: Math.round(ratio * 100),
        withinLabel: `${xpWithinLevel.toLocaleString()} / ${xpForCurrentLevelStep.toLocaleString()} XP`,
        toNextLabel: overFull
            ? 'ready to level up'
            : `${xpToNextLevel.toLocaleString()} XP to level ${level + 1}`,
    };
}
