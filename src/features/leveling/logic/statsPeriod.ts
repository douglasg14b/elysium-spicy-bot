/** Max bars on the stats activity chart before switching from daily to weekly buckets. */
export const STATS_CHART_MAX_BARS = 52;

export type StatsPeriod = 'week' | 'month' | 'year';

export const DEFAULT_STATS_PERIOD: StatsPeriod = 'week';

/** Year uses 52×7 days so weekly chart buckets stay within {@link STATS_CHART_MAX_BARS}. */
export const STATS_PERIOD_DAYS: Record<StatsPeriod, number> = {
    week: 7,
    month: 30,
    year: 52 * 7,
} as const;

/**
 * The periods, as data, for the places that need to enumerate them.
 *
 * Ordered shortest to longest because that is the order a period picker offers them.
 * Held to the type by `satisfies` in both directions — a member that is not a
 * `StatsPeriod` is rejected here, and `STATS_PERIOD_DAYS` above cannot omit one — so this
 * cannot drift from the union it mirrors.
 */
export const STATS_PERIODS = ['week', 'month', 'year'] as const satisfies readonly StatsPeriod[];

/**
 * A period the list above omits, or a name there that is not a period; `never` when the two
 * agree. Asserted `never` in `__tests__/statsPeriod.test-d.ts`, which `pnpm test`
 * type-checks — the `satisfies` above alone fails only root `tsc`, and says nothing about one
 * the list *omits*, which is the direction that actually rots: adding `'quarter'` to the
 * union would leave this list silently short and every period picker missing it.
 */
export type StatsPeriodsMismatch =
    | Exclude<StatsPeriod, (typeof STATS_PERIODS)[number]>
    | Exclude<(typeof STATS_PERIODS)[number], StatsPeriod>;

/**
 * Do not delete as unused: it is what shows a drift to root `tsc` and the editor, in this
 * file. The tuple wrapper is load-bearing: a bare `Mismatch extends never` distributes over
 * the union and is vacuously true for an empty one, so it would pass whatever the list said.
 */
const statsPeriodsAgree: [StatsPeriodsMismatch] extends [never]
    ? true
    : ['STATS_PERIODS disagrees with StatsPeriod', StatsPeriodsMismatch] = true;

void statsPeriodsAgree;

export type ActivityChartGranularity = 'daily' | 'weekly';

export function parseStatsPeriod(value: string | null): StatsPeriod {
    if (value === 'month' || value === 'year') {
        return value;
    }

    return DEFAULT_STATS_PERIOD;
}

export function getStatsPeriodDays(period: StatsPeriod): number {
    return STATS_PERIOD_DAYS[period];
}

export function resolveActivityChartGranularity(periodDays: number): ActivityChartGranularity {
    return periodDays <= STATS_CHART_MAX_BARS ? 'daily' : 'weekly';
}

export function formatStatsPeriodChartLabel(period: StatsPeriod): string {
    switch (period) {
        case 'week':
            return '7d';
        case 'month':
            return '30d';
        case 'year':
            return '1y';
    }
}
