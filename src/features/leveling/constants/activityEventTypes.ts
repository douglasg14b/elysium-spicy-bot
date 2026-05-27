export const LEVELING_ACTIVITY_EVENT_TYPES = ['message', 'reaction'] as const;

export type LevelingActivityEventType = (typeof LEVELING_ACTIVITY_EVENT_TYPES)[number];
