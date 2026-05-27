/**
 * MEE6-style per-level threshold: XP required to advance from level L to L+1.
 */
export function getXpThresholdForLevel(level: number): number {
    return 5 * level * level + 50 * level + 100;
}

/**
 * Total lifetime XP required to reach the given level (level 1 = 0 XP).
 */
export function getTotalXpForLevel(level: number): number {
    if (level <= 1) {
        return 0;
    }

    let total = 0;
    for (let currentLevel = 1; currentLevel < level; currentLevel++) {
        total += getXpThresholdForLevel(currentLevel);
    }

    return total;
}

/**
 * Derive the current level from lifetime total XP.
 */
export function getLevelFromTotalXp(totalXp: number): number {
    if (totalXp <= 0) {
        return 1;
    }

    let level = 1;
    let cumulativeXp = 0;

    while (true) {
        const threshold = getXpThresholdForLevel(level);
        if (cumulativeXp + threshold <= totalXp) {
            cumulativeXp += threshold;
            level++;
        } else {
            break;
        }
    }

    return level;
}

/**
 * XP progress within the current level (0-based offset from level floor).
 */
export function getXpProgressWithinLevel(totalXp: number, level: number): number {
    return totalXp - getTotalXpForLevel(level);
}

/**
 * XP still needed to reach the next level from the current total XP.
 */
export function getXpToNextLevel(totalXp: number): number {
    const level = getLevelFromTotalXp(totalXp);
    const threshold = getXpThresholdForLevel(level);
    const progress = getXpProgressWithinLevel(totalXp, level);
    return threshold - progress;
}

export function rollRandomXp(min: number, max: number, randomValue: number = Math.random()): number {
    if (min > max) {
        throw new Error(`Invalid XP range: min (${min}) must be <= max (${max})`);
    }

    const range = max - min + 1;
    return min + Math.floor(randomValue * range);
}

export function messageHasImageAttachment(
    attachments: ReadonlyArray<{ contentType: string | null; width?: number | null; height?: number | null }>
): boolean {
    return attachments.some((attachment) => {
        if (attachment.contentType?.startsWith('image/')) {
            return true;
        }

        return (
            attachment.width != null &&
            attachment.height != null &&
            attachment.width > 0 &&
            attachment.height > 0
        );
    });
}
