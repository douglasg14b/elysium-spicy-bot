/**
 * Leveling's public surface.
 *
 * Leveling is a base capability: other features consume it and the dependency runs one
 * way. It must never import the flow engine — the seam in `levelUpSubscribers` is how the
 * two are allowed to meet, and `__tests__/dependencyDirection.test.ts` enforces it.
 */
export { initLeveling, resetLevelingInitializationForTests, stopLeveling } from './initLeveling';

export { registerLevelUpSubscriber, clearLevelUpSubscriber } from './levelUpSubscribers';
export type { LevelUpEvent, LevelUpSubscriber } from './levelUpSubscribers';

export { awardFlowXp } from './awardFlowXp';
export type { AwardFlowXpInput, AwardFlowXpResult, FlowXpRefusal } from './awardFlowXp';

export { loadUserLevelStats } from './logic/loadUserLevelStats';
export type { UserLevelStats, ActivityChart } from './logic/loadUserLevelStats';

export { loadGuildLevelRankings, DEFAULT_GUILD_RANKINGS_LIMIT } from './logic/loadGuildLevelRankings';
export type { GuildLevelRankings, GuildLevelRankingEntry } from './logic/loadGuildLevelRankings';

export { loadUserLevelProfile } from './logic/loadUserLevelProfile';
export type { UserLevelProfile } from './logic/userLevelProfile';

export { getLevelFromTotalXp } from './logic/xpCalculator';

export { DEFAULT_STATS_PERIOD, STATS_PERIODS, parseStatsPeriod, getStatsPeriodDays } from './logic/statsPeriod';
export type { StatsPeriod, ActivityChartGranularity } from './logic/statsPeriod';

export { ACTIVITY_STATUSES } from './cards/statsCard/statsCardMetrics';
export type { ActivityStatus, StatsCardMetrics } from './cards/statsCard/statsCardMetrics';

export { levelingConfigRepo } from './data/levelingConfigRepo';
export type { LevelingConfig } from './data/levelingConfigSchema';
export type { LevelingProgress } from './data/levelingProgressSchema';
export type { LevelingActivityTotals, DailyActivityBucket } from './data/levelingActivityEventSchema';
