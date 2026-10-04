import { describe, expect, it } from 'vitest';
import {
    CHART_HEIGHT_PX,
    EMPTY_BAR_HEIGHT_PX,
    MIN_VISIBLE_BAR_PERCENT,
    activityChartView,
} from '../levelingChart';
import type { LevelingActivityBucket, LevelingActivityChart } from '@brattybot/web-sdk';

/**
 * The chart's scale, which is the only thing about it that can be wrong invisibly: a bar
 * scaled against the wrong denominator still looks like a chart.
 */

function bucket(
    activityDate: string,
    counts: Partial<Omit<LevelingActivityBucket, 'activityDate'>> = {}
): LevelingActivityBucket {
    return {
        activityDate,
        messageCount: 0,
        reactionCount: 0,
        photoUploadCount: 0,
        voiceSessionCount: 0,
        ...counts,
    };
}

function chart(buckets: LevelingActivityBucket[]): LevelingActivityChart {
    return { granularity: 'daily', buckets };
}

describe('activityChartView', () => {
    it('scales every bar against the tallest bucket', () => {
        const view = activityChartView(
            chart([
                bucket('2026-09-01', { messageCount: 10 }),
                bucket('2026-09-02', { messageCount: 5 }),
                bucket('2026-09-03', { messageCount: 20 }),
            ])
        );

        expect(view.peak).toBe(20);
        expect(view.bars.map((bar) => bar.heightPercent)).toEqual([50, 25, 100]);
    });

    it('counts every kind of event towards a bar, not just messages', () => {
        // The chart claims to show activity, and a reaction is activity. Summing only
        // messages would draw a flat line for somebody who lives in voice.
        //
        // The counts are deliberately realistic: two of the four messages carried an image,
        // which is the only way a photo count can arise. An earlier version of this test used
        // `messageCount: 1, photoUploadCount: 3` — a combination the server cannot emit — and
        // asserted the resulting 10, pinning the double-count below as correct.
        const view = activityChartView(
            chart([
                bucket('2026-09-01', {
                    messageCount: 4,
                    reactionCount: 2,
                    photoUploadCount: 2,
                    voiceSessionCount: 1,
                }),
            ])
        );

        expect(view.bars[0]?.total).toBe(7);
        expect(view.total).toBe(7);
    });

    it('does not count a photo message twice', () => {
        /*
         * A photo upload is a flag on a message, not an event beside it: the server grants one
         * `message` event with `photoBonusApplied`, and its aggregation increments
         * `messageCount` and `photoUploadCount` from that same row. So a bucket of one photo
         * message is one event, and adding both counters reported two.
         *
         * This is the regression guard for the whole finding — it fails on the old arithmetic
         * and passes on the new, where the broader test above would not have, since 4+2+2+1
         * and 4+2+1 differ by the photo count either way.
         */
        const view = activityChartView(chart([bucket('2026-09-01', { messageCount: 1, photoUploadCount: 1 })]));

        expect(view.bars[0]?.total).toBe(1);
        expect(view.peak).toBe(1);
        // Still reported on the bar, for the tooltip's breakdown — excluded from the total,
        // not dropped from the data.
        expect(view.bars[0]?.photoUploadCount).toBe(1);
    });

    it('gives a single event against a huge peak a visible sliver', () => {
        // 1/400 rounds to 0% and vanishes, which reads as a day with nothing on it.
        const view = activityChartView(
            chart([bucket('2026-09-01', { messageCount: 400 }), bucket('2026-09-02', { messageCount: 1 })])
        );

        expect(view.bars[1]?.heightPercent).toBe(MIN_VISIBLE_BAR_PERCENT);
    });

    it('floors the sliver clear of the height an empty bucket is drawn at', () => {
        /*
         * The floor and the page's empty-bucket hairline have to differ by enough to see. At a
         * 96px chart a 2% floor is 1.92px, which the hairline's `minHeight: 2` rounds up to
         * exactly 2px — so a bucket with one event and a bucket with none rendered identically
         * and the tested floor did nothing. Asserted as a relationship between the two
         * exported constants rather than as a pixel count, since the chart height lives in the
         * page and this module cannot see it.
         */
        expect(MIN_VISIBLE_BAR_PERCENT).toBeGreaterThan((EMPTY_BAR_HEIGHT_PX / CHART_HEIGHT_PX) * 100);
    });

    it('keeps an empty bucket at zero rather than giving it the sliver', () => {
        // The floor is for "barely anything", not for "nothing" — a day off must look like
        // a day off.
        const view = activityChartView(
            chart([bucket('2026-09-01', { messageCount: 40 }), bucket('2026-09-02')])
        );

        expect(view.bars[1]?.heightPercent).toBe(0);
    });

    it('does not divide by a peak of zero', () => {
        // Every bar 0%, not `NaN%` in a style attribute.
        const view = activityChartView(chart([bucket('2026-09-01'), bucket('2026-09-02')]));

        expect(view.peak).toBe(0);
        expect(view.bars.every((bar) => bar.heightPercent === 0)).toBe(true);
        // "They were here and did nothing" — distinct from a window with no days in it.
        expect(view.allEmpty).toBe(true);
    });

    it('does not call an empty window all-empty', () => {
        // No buckets at all is a different sentence from buckets that are all zero, and a
        // chart of invisible bars says neither.
        const view = activityChartView(chart([]));

        expect(view.allEmpty).toBe(false);
        expect(view.bars).toEqual([]);
        expect(view.total).toBe(0);
    });

    it('carries the bucket date and the breakdown through for the tooltip', () => {
        const view = activityChartView(
            chart([bucket('2026-09-15', { messageCount: 3, voiceSessionCount: 1 })])
        );

        expect(view.bars[0]).toMatchObject({
            activityDate: '2026-09-15',
            messageCount: 3,
            voiceSessionCount: 1,
            reactionCount: 0,
            photoUploadCount: 0,
        });
    });
});
