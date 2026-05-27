export function getLevelCardProgressRatio(xpWithinLevel: number, xpForCurrentLevelStep: number): number {
    if (xpForCurrentLevelStep <= 0) {
        return 0;
    }

    return Math.min(Math.max(xpWithinLevel / xpForCurrentLevelStep, 0), 1);
}

export function getLevelCardProgressPercent(xpWithinLevel: number, xpForCurrentLevelStep: number): number {
    return Math.round(getLevelCardProgressRatio(xpWithinLevel, xpForCurrentLevelStep) * 100);
}
