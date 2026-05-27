import {
    DEFAULT_MESSAGE_XP_MAX,
    DEFAULT_MESSAGE_XP_MIN,
    DEFAULT_PHOTO_XP_BONUS_MAX,
    DEFAULT_PHOTO_XP_BONUS_MIN,
    DEFAULT_REACTION_XP_MAX,
    DEFAULT_REACTION_XP_MIN,
} from '../constants';
import { LevelingConfig } from '../data/levelingConfigSchema';
import { applyLevelingCodeDefaults } from './levelingConfigDefaults';
import { getExtraLongMessageXp, getLongMessageXp, getShortMessageXp } from './messageXp';
import { getTotalXpForLevel, getXpThresholdForLevel } from './xpCalculator';

export type XpRange = {
    min: number;
    max: number;
    avg: number;
};

export type ActionCountEstimate = {
    /** Fewest actions if every grant rolls maximum XP. */
    min: number;
    /** Most actions if every grant rolls minimum XP. */
    max: number;
    /** Estimate using average XP per action. */
    avg: number;
};

export type LevelStepPreview = {
    level: number;
    nextLevel: number;
    xpRequired: number;
    cumulativeXp: number;
    shortMessages: ActionCountEstimate;
    longMessages: ActionCountEstimate;
    extraLongMessages: ActionCountEstimate;
    reactions: ActionCountEstimate | null;
    photoMessages: ActionCountEstimate | null;
};

export type LevelCurvePreview = {
    maxLevel: number;
    shortMessageXp: number;
    longMessageXp: number;
    extraLongMessageXp: number;
    reactionXp: XpRange | null;
    photoMessageXp: XpRange | null;
    steps: LevelStepPreview[];
    cumulativeToMaxLevel: {
        totalXp: number;
        shortMessages: ActionCountEstimate;
        longMessages: ActionCountEstimate;
        extraLongMessages: ActionCountEstimate;
        reactions: ActionCountEstimate | null;
        photoMessages: ActionCountEstimate | null;
    };
};

export type LevelCurvePreviewOptions = {
    maxLevel: number;
    messageXpMin: number;
    messageXpMax: number;
    reactionXpMin: number;
    reactionXpMax: number;
    reactionXpEnabled: boolean;
    photoXpBonusMin: number;
    photoXpBonusMax: number;
    photoBonusEnabled: boolean;
};

const MIN_PREVIEW_LEVEL = 2;
const MAX_PREVIEW_LEVEL = 25;
const DEFAULT_PREVIEW_LEVEL = 10;

export function clampPreviewMaxLevel(maxLevel: number): number {
    if (!Number.isFinite(maxLevel)) {
        return DEFAULT_PREVIEW_LEVEL;
    }

    return Math.min(MAX_PREVIEW_LEVEL, Math.max(MIN_PREVIEW_LEVEL, Math.floor(maxLevel)));
}

export function buildXpRange(min: number, max: number): XpRange {
    return {
        min,
        max,
        avg: (min + max) / 2,
    };
}

export function estimateActionsNeeded(xpRequired: number, xpPerAction: number): ActionCountEstimate {
    if (xpRequired <= 0 || xpPerAction <= 0) {
        return { min: 0, max: 0, avg: 0 };
    }

    const count = Math.ceil(xpRequired / xpPerAction);
    return { min: count, max: count, avg: count };
}

export function estimateActionsNeededFromRange(xpRequired: number, xpRange: XpRange): ActionCountEstimate {
    if (xpRequired <= 0) {
        return { min: 0, max: 0, avg: 0 };
    }

    return {
        min: Math.ceil(xpRequired / xpRange.max),
        max: Math.ceil(xpRequired / xpRange.min),
        avg: Math.ceil(xpRequired / xpRange.avg),
    };
}

export function buildLevelCurvePreview(options: LevelCurvePreviewOptions): LevelCurvePreview {
    const maxLevel = clampPreviewMaxLevel(options.maxLevel);
    const shortMessageXp = getShortMessageXp(options.messageXpMin, options.messageXpMax);
    const longMessageXp = getLongMessageXp(options.messageXpMin, options.messageXpMax);
    const extraLongMessageXp = getExtraLongMessageXp(options.messageXpMin, options.messageXpMax);
    const reactionXp = options.reactionXpEnabled
        ? buildXpRange(options.reactionXpMin, options.reactionXpMax)
        : null;
    const photoMessageXp = options.photoBonusEnabled
        ? buildXpRange(
              shortMessageXp + options.photoXpBonusMin,
              extraLongMessageXp + options.photoXpBonusMax
          )
        : null;

    const steps: LevelStepPreview[] = [];

    for (let level = 1; level < maxLevel; level++) {
        const xpRequired = getXpThresholdForLevel(level);
        const cumulativeXp = getTotalXpForLevel(level + 1);

        steps.push({
            level,
            nextLevel: level + 1,
            xpRequired,
            cumulativeXp,
            shortMessages: estimateActionsNeeded(xpRequired, shortMessageXp),
            longMessages: estimateActionsNeeded(xpRequired, longMessageXp),
            extraLongMessages: estimateActionsNeeded(xpRequired, extraLongMessageXp),
            reactions: reactionXp ? estimateActionsNeededFromRange(xpRequired, reactionXp) : null,
            photoMessages: photoMessageXp ? estimateActionsNeededFromRange(xpRequired, photoMessageXp) : null,
        });
    }

    const totalXp = getTotalXpForLevel(maxLevel);

    return {
        maxLevel,
        shortMessageXp,
        longMessageXp,
        extraLongMessageXp,
        reactionXp,
        photoMessageXp,
        steps,
        cumulativeToMaxLevel: {
            totalXp,
            shortMessages: estimateActionsNeeded(totalXp, shortMessageXp),
            longMessages: estimateActionsNeeded(totalXp, longMessageXp),
            extraLongMessages: estimateActionsNeeded(totalXp, extraLongMessageXp),
            reactions: reactionXp ? estimateActionsNeededFromRange(totalXp, reactionXp) : null,
            photoMessages: photoMessageXp ? estimateActionsNeededFromRange(totalXp, photoMessageXp) : null,
        },
    };
}

export function previewOptionsFromConfig(
    config: LevelingConfig | null,
    maxLevel: number = DEFAULT_PREVIEW_LEVEL
): LevelCurvePreviewOptions {
    const resolved = config ? applyLevelingCodeDefaults(config) : null;

    return {
        maxLevel: clampPreviewMaxLevel(maxLevel),
        messageXpMin: resolved?.messageXpMin ?? DEFAULT_MESSAGE_XP_MIN,
        messageXpMax: resolved?.messageXpMax ?? DEFAULT_MESSAGE_XP_MAX,
        reactionXpMin: resolved?.reactionXpMin ?? DEFAULT_REACTION_XP_MIN,
        reactionXpMax: resolved?.reactionXpMax ?? DEFAULT_REACTION_XP_MAX,
        reactionXpEnabled: resolved?.reactionXpEnabled ?? true,
        photoXpBonusMin: resolved?.photoXpBonusMin ?? DEFAULT_PHOTO_XP_BONUS_MIN,
        photoXpBonusMax: resolved?.photoXpBonusMax ?? DEFAULT_PHOTO_XP_BONUS_MAX,
        photoBonusEnabled: resolved?.photoBonusEnabled ?? true,
    };
}

export function buildLevelCurvePreviewFromConfig(
    config: LevelingConfig | null,
    maxLevel: number = DEFAULT_PREVIEW_LEVEL
): LevelCurvePreview {
    return buildLevelCurvePreview(previewOptionsFromConfig(config, maxLevel));
}
