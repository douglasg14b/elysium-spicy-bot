export const DEFAULT_MESSAGE_XP_MIN = 8;
export const DEFAULT_MESSAGE_XP_MAX = 25;
export const DEFAULT_MESSAGE_COOLDOWN_MS = 20_000;

export type MessageXpKeyframe = {
    length: number;
    xp: number;
};

/** Log-interpolated anchors for length-based message XP (diminishing returns between points). */
export const MESSAGE_XP_KEYFRAMES: readonly MessageXpKeyframe[] = [
    { length: 5, xp: 8 },
    { length: 300, xp: 25 },
    { length: 3000, xp: 50 },
] as const;

export const SHORT_MESSAGE_SAMPLE_LENGTH = MESSAGE_XP_KEYFRAMES[0].length;
export const LONG_MESSAGE_SAMPLE_LENGTH = MESSAGE_XP_KEYFRAMES[1].length;
export const EXTRA_LONG_MESSAGE_SAMPLE_LENGTH = MESSAGE_XP_KEYFRAMES[2].length;

export const MESSAGE_XP_CAP = MESSAGE_XP_KEYFRAMES[MESSAGE_XP_KEYFRAMES.length - 1].xp;
export const MESSAGE_LENGTH_FOR_MAX_XP = MESSAGE_XP_KEYFRAMES[MESSAGE_XP_KEYFRAMES.length - 1].length;

/** Reactions are cheap engagement — minimal XP and a longer cooldown. */
export const DEFAULT_REACTION_XP_MIN = 1;
export const DEFAULT_REACTION_XP_MAX = 2;
export const DEFAULT_REACTION_COOLDOWN_MS = 180_000;

export const DEFAULT_PHOTO_XP_BONUS_MIN = 10;
export const DEFAULT_PHOTO_XP_BONUS_MAX = 20;

export const DEFAULT_REACTION_XP_ENABLED = true;
export const DEFAULT_PHOTO_XP_BONUS_ENABLED = true;

export const LEVELING_CONFIG_VERSION = 1;

/** Rolling window for "recent activity" on `/level`. */
export const LEVELING_RECENT_ACTIVITY_DAYS = 7;
