/**
 * One member's stats — the same figures `/level-stats` renders as a card, as a page.
 *
 * Shaped after `TicketDetailPage`: `useParams`, the id parsed before it can reach a fetch,
 * a breadcrumb that links back to the list, `Card p="lg"` sections and a
 * `Group align="stretch"` + `Card flex="1 1 300px"` pair for the side-by-side panels.
 *
 * **No `missing` state, unlike the ticket page, and that is the server's decision not an
 * omission.** `loadUserLevelStats` answers for any id: a member with no progress row is
 * level 1 with nothing recorded, because "this person has earned nothing yet" is a real
 * answer an operator asked for. The only 404-shaped failure is a malformed snowflake, which
 * the server rejects with a 400 — so the id is checked here first and a bad one never
 * becomes a request.
 *
 * The period switcher refetches rather than filtering client-side: the window decides which
 * rows the server aggregates and how coarse the chart's buckets are, and neither can be
 * recovered from a narrower response.
 *
 * **Every decision worth testing lives outside this file** — `xpProgress`, `activityChartView`,
 * `memberPresentation` and the formatters in `levelingPresentation`. There are no `.test.tsx`
 * files in this repo, so logic left in a component is logic nothing can test.
 */

import { useEffect, useRef, useState } from 'react';
import {
    Alert,
    Anchor,
    Avatar,
    Badge,
    Button,
    Card,
    Center,
    Group,
    Loader,
    Progress,
    SegmentedControl,
    SimpleGrid,
    Stack,
    Text,
    Title,
    Tooltip,
} from '@mantine/core';
import { IconAlertTriangle, IconChevronLeft, IconTrendingUp } from '@tabler/icons-react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { getLevelingUser } from '../api/leveling';
import { STATS_PERIODS, type LevelingUserDetail, type StatsPeriod } from '../api/types';
import { CHART_HEIGHT_PX, EMPTY_BAR_HEIGHT_PX, activityChartView } from '../leveling/levelingChart';
import { memberPresentation, type MemberPresentation } from '../leveling/levelingMember';
import {
    ACTIVITY_STATUS_PRESENTATION,
    STATS_PERIOD_LABELS,
    bucketLabel,
    formatMoment,
    formatMomentWithTime,
    formatOptionalNumber,
    formatPercent,
    formatRate,
    formatVoiceDuration,
} from '../leveling/levelingPresentation';
import { xpProgress } from '../leveling/levelingProgress';
import { useGuilds } from '../guilds/GuildContext';
import { PAGE_MAX_WIDTH } from '../theme';

/** A snowflake, checked the way the server checks it, so a bad id is never fetched. */
const SNOWFLAKE = /^\d{17,20}$/;

export function LevelingUserPage() {
    const { selected, loading: guildsLoading } = useGuilds();
    const { userId: rawUserId } = useParams<{ userId: string }>();

    const [detail, setDetail] = useState<LevelingUserDetail | null>(null);
    /*
     * The window the operator has *asked* for, null until they ask.
     *
     * Null is not "week": hardcoding a default here would have this side assert one the bot
     * owns, and `DEFAULT_STATS_PERIOD` moving to `month` would silently put the picker out of
     * step with `/level-stats`. The first read sends no `period` at all and the server answers
     * with its own.
     *
     * What the control *displays* is `detail.statsPeriod` — the window actually aggregated —
     * not this. Keeping the request and the answer as separate values is what lets the first
     * read have no opinion without a second fetch: adopting the response into this state would
     * change an effect dependency and re-run the read with the same window.
     */
    const [requestedPeriod, setRequestedPeriod] = useState<StatsPeriod | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const guildId = selected?.id;
    // Validated here so a mangled path segment is answered on this page rather than sent to
    // the API to come back as a 400 an operator has to interpret.
    const userId = rawUserId && SNOWFLAKE.test(rawUserId) ? rawUserId : null;

    /*
     * Shared by every read, so the last one dispatched is the only one allowed to write.
     * The period switcher can be clicked faster than a year's aggregation returns, and
     * without this a slow `year` response lands after a fast `week` one, showing year data
     * under a control reading "7 days".
     */
    const readGeneration = useRef(0);

    useEffect(() => {
        if (!guildId || !userId) {
            // Lowered rather than left alone: `loading` starts true so the first paint is a
            // spinner, and bailing without clearing it spins forever with nothing to explain
            // why.
            setLoading(false);
            return;
        }
        const generation = ++readGeneration.current;
        void (async () => {
            setLoading(true);
            setError(null);
            try {
                // `?? undefined` so the first read omits the query parameter entirely and the
                // server's own default decides the window.
                const loaded = await getLevelingUser(guildId, userId, requestedPeriod ?? undefined);
                if (generation === readGeneration.current) setDetail(loaded);
            } catch (err) {
                const message =
                    err instanceof ApiError ? err.message : 'Failed to load those stats';
                if (generation === readGeneration.current) setError(message);
            } finally {
                if (generation === readGeneration.current) setLoading(false);
            }
        })();
    }, [guildId, userId, requestedPeriod]);

    if (guildsLoading) {
        return (
            <Center mih="60vh">
                <Loader color="brand" />
            </Center>
        );
    }

    if (!selected) {
        return (
            <Alert color="gray" title="No server">
                The bot isn&apos;t in any server you can manage.
            </Alert>
        );
    }

    const person = detail ? memberPresentation(detail.member, detail.userId) : null;

    const breadcrumb = (
        <div>
            <Text size="12.5px" c="dark.2">
                <Text span c="dark.1" fw={600}>
                    {selected.name}
                </Text>{' '}
                › Configure ›{' '}
                <Anchor component={Link} to="/leveling" size="12.5px" c="dark.2" underline="hover">
                    Leveling
                </Anchor>{' '}
                › {person ? person.name : 'Member'}
            </Text>
        </div>
    );

    if (!userId) {
        return (
            <Stack gap="lg" maw={PAGE_MAX_WIDTH}>
                {breadcrumb}
                <Alert color="gray" icon={<IconAlertTriangle size={16} />} title="Not a user id">
                    <Stack gap="sm" align="flex-start">
                        <Text size="13.5px">
                            <Text span ff="monospace">
                                {rawUserId}
                            </Text>{' '}
                            isn&apos;t a Discord user id. Something mangled the link on the way
                            here.
                        </Text>
                        <BackToLeaderboard />
                    </Stack>
                </Alert>
            </Stack>
        );
    }

    return (
        <Stack gap="lg" maw={PAGE_MAX_WIDTH}>
            {breadcrumb}

            {/*
             * The header and switcher stay mounted through a refetch — only the very first
             * read shows a bare spinner. Replacing the page on every period click reads as a
             * reload rather than a window changing, and the control would jump out from under
             * the cursor.
             */}
            {loading && !detail ? (
                <Center py="xl">
                    <Loader color="brand" size="sm" />
                </Center>
            ) : error ? (
                <Alert
                    color="red"
                    icon={<IconAlertTriangle size={16} />}
                    title="Couldn't load those stats"
                >
                    <Stack gap="sm" align="flex-start">
                        <Text size="13.5px">{error}</Text>
                        <BackToLeaderboard />
                    </Stack>
                </Alert>
            ) : detail && person ? (
                <LoadedStats
                    detail={detail}
                    person={person}
                    refetching={loading}
                    onPeriodChange={setRequestedPeriod}
                />
            ) : null}
        </Stack>
    );
}

/**
 * The page once there is something to show.
 *
 * Split out so `detail` is non-null for the whole body rather than optional-chained in forty
 * places, and so the derived views — the XP bar, the chart scale — are computed **once** at
 * the top. Recomputing them where each is rendered is how the caption and the bars end up
 * disagreeing after somebody edits one.
 */
function LoadedStats({
    detail,
    person,
    refetching,
    onPeriodChange,
}: {
    detail: LevelingUserDetail;
    person: MemberPresentation;
    refetching: boolean;
    onPeriodChange: (period: StatsPeriod) => void;
}) {
    const progress = xpProgress(detail);
    const chart = activityChartView(detail.activityChart);
    const status = ACTIVITY_STATUS_PRESENTATION[detail.metrics.activityStatus];
    const bucketWord = detail.activityChart.granularity === 'weekly' ? 'week' : 'day';

    return (
        <>
            <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
                <Group gap="md" wrap="nowrap">
                    <Avatar src={person.avatarUrl ?? undefined} radius="xl" size={56} color="brand">
                        {person.monogram}
                    </Avatar>
                    <div>
                        <Group gap={8} wrap="wrap">
                            <Title order={1} size="24px">
                                {person.name}
                            </Title>
                            <Badge variant="light" radius="sm" color={status.color}>
                                {status.label}
                            </Badge>
                            {person.isBot ? (
                                <Badge variant="light" color="gray" radius="sm">
                                    Bot
                                </Badge>
                            ) : null}
                        </Group>
                        <Group gap={8} mt={4}>
                            {person.handle ? (
                                <Text size="12.5px" c="dark.2">
                                    @{person.handle}
                                </Text>
                            ) : null}
                            <Text size="12.5px" c="dark.2" ff="monospace">
                                {detail.userId}
                            </Text>
                        </Group>
                        {/*
                         * A departed member keeps their XP and their page. Said in the header
                         * because every figure below is historical for them and nothing else
                         * on the page would mention it.
                         */}
                        {person.departed ? (
                            <Text size="12px" c="red.4" mt={4} maw={480}>
                                Discord no longer resolves this account in this server. They
                                left; the XP stayed. Everything below is what they earned before
                                they went.
                            </Text>
                        ) : null}
                    </div>
                </Group>

                <Stack gap={4} align="flex-end">
                    <Group gap={6}>
                        <Text size="11px" c="dark.2" fw={700} tt="uppercase">
                            Recent window
                        </Text>
                        {/* Never `disabled` while a read is in flight — the control would lose
                            focus mid-click. A quiet spinner says "working" without touching it. */}
                        {refetching ? <Loader size={12} color="brand" /> : null}
                    </Group>
                    <SegmentedControl
                        size="xs"
                        // The window the server actually aggregated, not the one requested.
                        // On the first read nothing was requested, so this is the only thing
                        // that knows which of the three is in force.
                        value={detail.statsPeriod}
                        onChange={(value) => onPeriodChange(value as StatsPeriod)}
                        // Built from the mirrored vocabulary rather than three literals, so a
                        // period the bot gains appears here instead of being a fourth string
                        // somebody has to remember to add.
                        data={STATS_PERIODS.map((candidate) => ({
                            value: candidate,
                            label: STATS_PERIOD_LABELS[candidate],
                        }))}
                    />
                </Stack>
            </Group>

            <Card p="lg">
                <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm">
                    <Group gap={10} align="center">
                        <IconTrendingUp size={20} color="var(--mantine-color-brand-6)" />
                        <Title order={2} size="18px">
                            Level {detail.level}
                        </Title>
                        <Text size="13px" c="dark.2">
                            {detail.totalXp.toLocaleString()} XP banked, all time
                        </Text>
                    </Group>
                    <Text size="12.5px" c="dark.2">
                        {progress.withinLabel} · {progress.toNextLabel}
                    </Text>
                </Group>
                <Progress mt="sm" size="lg" radius="xl" color="brand" value={progress.percent} />
            </Card>

            <Group align="stretch" gap="md" wrap="wrap">
                {/*
                 * Recent and all-time side by side, with the window named on the recent card.
                 * `recentPeriodDays` is the server's own figure — the `year` period is 52×7
                 * days, not 365, so a constant printed here would disagree with what was
                 * actually aggregated.
                 */}
                <Card p="lg" flex="1 1 300px">
                    <Text fw={700} size="15px">
                        Last {detail.recentPeriodDays} days
                    </Text>
                    <Text size="12px" c="dark.2" mb="sm">
                        What they have been up to lately.
                    </Text>
                    <Stack gap="sm">
                        <StatRow
                            label="Messages"
                            value={detail.recentActivity.messageCount.toLocaleString()}
                        />
                        <StatRow
                            label="Reactions"
                            value={detail.recentActivity.reactionCount.toLocaleString()}
                        />
                        <StatRow
                            label="Photos"
                            value={detail.recentActivity.photoUploadCount.toLocaleString()}
                        />
                        <StatRow
                            label="Voice sessions"
                            value={detail.recentActivity.voiceSessionCount.toLocaleString()}
                        />
                        <StatRow
                            label="XP earned"
                            value={detail.recentActivity.totalXp.toLocaleString()}
                        />
                    </Stack>
                </Card>

                <Card p="lg" flex="1 1 300px">
                    <Text fw={700} size="15px">
                        All time
                    </Text>
                    {/*
                     * Names its source, because it is not the same source as the leaderboard's
                     * columns and the two disagree systematically. These figures come from the
                     * logged activity events; the leaderboard reads the progress row's running
                     * counters, and `grantXp` writes the event *before* it bails on a cooldown —
                     * so a cooldown-suppressed message logs an event without incrementing the
                     * counter, and this side reads permanently higher. Saying so is cheaper than
                     * an operator concluding one of the two pages is broken.
                     */}
                    <Text size="12px" c="dark.2" mb="sm">
                        Every logged activity event, since the bot started counting — the leaderboard’s
                        columns come from the running counters and can read a little lower.
                    </Text>
                    <Stack gap="sm">
                        <StatRow
                            label="Messages"
                            value={detail.totalActivity.messageCount.toLocaleString()}
                        />
                        <StatRow
                            label="Reactions"
                            value={detail.totalActivity.reactionCount.toLocaleString()}
                        />
                        <StatRow
                            label="Photos"
                            value={detail.totalActivity.photoUploadCount.toLocaleString()}
                        />
                        {/*
                         * `detail.voiceSessionCount`, not `detail.totalActivity.voiceSessionCount`.
                         * The server fills the former from the progress row's running counter
                         * and the latter by aggregating the activity-events table, so the two
                         * are separate tallies of the same thing and can disagree. The running
                         * counter is the one paired with `totalVoiceSeconds` beside it, and a
                         * count from one source next to a duration from another would be two
                         * numbers nobody could reconcile.
                         */}
                        <StatRow
                            label="Voice sessions"
                            value={detail.voiceSessionCount.toLocaleString()}
                        />
                        <StatRow
                            label="Voice time"
                            value={formatVoiceDuration(detail.totalVoiceSeconds)}
                        />
                    </Stack>
                </Card>
            </Group>

            <Card p="lg">
                <Group justify="space-between" align="flex-end" wrap="wrap">
                    <div>
                        <Text fw={700} size="15px">
                            Activity over the window
                        </Text>
                        <Text size="12px" c="dark.2">
                            {/*
                             * Which bucket a bar is, said plainly: the server switches to
                             * weekly past 52 days, so a year's chart is 52 bars of a week each
                             * and reading them as days would be wrong by a factor of seven.
                             */}
                            One bar per {bucketWord}, scaled against the busiest one.
                        </Text>
                    </div>
                    <Text size="12px" c="dark.2" ta="right">
                        {chart.total.toLocaleString()} events · busiest {bucketWord}{' '}
                        {chart.peak.toLocaleString()}
                    </Text>
                </Group>

                {chart.bars.length === 0 ? (
                    <Text size="13px" c="dimmed" mt="md">
                        No buckets in this window at all. Try a longer one.
                    </Text>
                ) : (
                    <>
                        <Group
                            gap={3}
                            mt="md"
                            align="flex-end"
                            wrap="nowrap"
                            h={CHART_HEIGHT_PX}
                            style={{ overflowX: 'auto' }}
                        >
                            {chart.bars.map((bar) => (
                                <Tooltip
                                    key={bar.activityDate}
                                    withArrow
                                    /*
                                     * Photos read as a qualifier on the message count, not as a
                                     * fourth peer: they are a flag on a message, so listing them
                                     * alongside made the three-plus-one breakdown fail to add up
                                     * to the total beside it.
                                     *
                                     * The date is prefixed on a weekly chart because the server
                                     * sets `activityDate` to the week's *first* day, so a bare
                                     * `9/15` reads as a single day holding a week's events.
                                     */
                                    label={`${bucketLabel(bar.activityDate, detail.activityChart.granularity)} · ${bar.total} events — ${bar.messageCount} msg${bar.photoUploadCount > 0 ? ` (${bar.photoUploadCount} with photos)` : ''}, ${bar.reactionCount} reactions, ${bar.voiceSessionCount} voice`}
                                >
                                    <div
                                        style={{
                                            flex: '1 1 6px',
                                            minWidth: 4,
                                            // A percentage of the row's fixed height, so the
                                            // tallest bar fills it and the rest are honestly
                                            // proportional to it.
                                            height: `${bar.heightPercent}%`,
                                            // An empty bucket keeps a hairline, so the axis
                                            // reads as a continuous window rather than a row
                                            // with holes in it. Taken from the chart module,
                                            // which floors a non-empty bar well above it —
                                            // hard-coding a second number here is what once
                                            // made the floor and the hairline the same height.
                                            minHeight: EMPTY_BAR_HEIGHT_PX,
                                            borderRadius: 2,
                                            background:
                                                bar.total > 0
                                                    ? 'var(--mantine-color-brand-6)'
                                                    : 'var(--mantine-color-dark-5)',
                                        }}
                                    />
                                </Tooltip>
                            ))}
                        </Group>
                        {chart.allEmpty ? (
                            <Text size="12px" c="dark.2" mt="xs">
                                Every bucket in this window is empty. They were around; they did
                                nothing.
                            </Text>
                        ) : null}
                    </>
                )}
            </Card>

            <Card p="lg">
                <Text fw={700} size="15px" mb="sm">
                    The numbers behind it
                </Text>
                <SimpleGrid cols={{ base: 2, sm: 3, md: 4 }} spacing="md">
                    <Metric
                        label="Last active"
                        value={formatMomentWithTime(detail.metrics.lastActiveAt)}
                    />
                    <Metric
                        label="First seen"
                        value={formatMoment(detail.metrics.memberSince)}
                        // Deliberately not "member since": the server reads
                        // `progress.createdAt`, which is when the bot first recorded them, not
                        // Discord's join date. Labelling it as a join date would be wrong for
                        // every member who predates the leveling feature.
                        hint="When the bot first recorded this member — not their Discord join date. Anyone who predates leveling first appears here on the day they next did something."
                    />
                    <Metric
                        label="Tenure"
                        value={`${detail.metrics.tenureDays.toLocaleString()} days`}
                        hint="Days since first seen, floored at 1 — it is the denominator for the all-time rate."
                    />
                    <Metric
                        label="Messages / day"
                        value={formatRate(detail.metrics.recentMsgsPerDay)}
                        hint="Over the recent window above."
                    />
                    <Metric
                        label="XP / day"
                        value={formatRate(detail.metrics.recentXpPerDay)}
                        hint="Over the recent window above."
                    />
                    <Metric
                        label="Messages / day (all time)"
                        value={formatRate(detail.metrics.allTimeMsgsPerDay)}
                        hint="All-time messages divided by tenure."
                    />
                    <Metric
                        label="Share: messages"
                        value={formatPercent(detail.metrics.messageSharePercent)}
                        // The trap worth naming: it is a share of this member's own recent
                        // engagement, not of the server's traffic.
                        hint="How this member's own recent activity splits across messages, reactions and voice — not their share of the server."
                    />
                    <Metric
                        label="Share: reactions"
                        value={formatPercent(detail.metrics.reactionSharePercent)}
                        hint="Same split: their reactions as a share of their own recent activity."
                    />
                    <Metric
                        label="Share: voice"
                        value={formatPercent(detail.metrics.voiceSharePercent)}
                        hint="Same split, taken as the remainder so the three add to 100."
                    />
                    <Metric
                        label="Photo rate"
                        value={formatPercent(detail.metrics.photoRatePercent)}
                        /*
                         * Bounded by 100%, and counted per *message* rather than per
                         * attachment: the server stores `photoBonusApplied` as a boolean on a
                         * message event, so numerator and denominator come from the same rows
                         * and a post with six images counts once. The previous copy promised
                         * "over 100% means several images per message", which cannot happen and
                         * read the metric backwards at the top of its range.
                         */
                        hint="Share of their recent messages that carried at least one image. Counted per message, not per attachment — a post with six photos counts once."
                    />
                    <Metric
                        label="Avg message length"
                        // Zero decimals: the server already rounds this to a whole number
                        // (`computeAvgMessageLength`), so the default one decimal rendered
                        // `42.0` and advertised a precision the figure does not carry.
                        value={formatOptionalNumber(detail.metrics.avgMessageLengthRecent, 0)}
                        hint="Characters, recent window. A dash means there were no messages to average."
                    />
                    <Metric
                        label="Avg XP / message"
                        value={formatOptionalNumber(detail.metrics.avgXpPerMessageRecent)}
                        hint="Recent window. A dash means there were no messages to average."
                    />
                    {/*
                     * `Busiest {bucketWord}`, not "Busiest day" — the server feeds
                     * `dailyPeakEvents` from `activityChart.buckets`, *after* they have been
                     * aggregated, so on the `year` period (364 days, past the 52-bar cap) it
                     * is the busiest seven-day run and calling it a day inflates it ~7x. Read
                     * from the same `granularity` the chart caption uses, so the two panels
                     * cannot disagree about what a bucket is.
                     *
                     * The name of the server field says `daily`; it is only daily for `week`
                     * and `month`. Renaming it is the root-cause fix and belongs server-side.
                     */}
                    <Metric
                        label={`Busiest ${bucketWord}`}
                        value={detail.metrics.dailyPeakEvents.toLocaleString()}
                        /*
                         * Counted the same way as the chart's bars, deliberately: both sum
                         * messages, reactions and voice sessions and both leave photo uploads
                         * out, because a photo is a flag on a message rather than an event
                         * beside it. So this figure *is* the tallest bar, and saying otherwise
                         * would send an operator looking for a discrepancy that is not there.
                         */
                        hint={
                            bucketWord === 'week'
                                ? 'Messages, reactions and voice sessions in their busiest single week — a year is bucketed weekly, so this is not a per-day figure. Matches the chart’s tallest bar.'
                                : 'Messages, reactions and voice sessions on their busiest single day. Matches the chart’s tallest bar.'
                        }
                    />
                </SimpleGrid>
            </Card>

            {/*
             * Said last rather than instead of the page. Every figure above is legitimately
             * zero for somebody who has never done anything, and an operator looking at a wall
             * of zeros deserves to know that is the answer rather than a failed load.
             */}
            {!detail.hasAnyActivity ? (
                <Alert color="gray" title="Nothing on record">
                    Not a single message, reaction or session logged for this member. The zeros
                    above are the answer, not a broken query — they have either never said a word
                    or they arrived before the bot started counting.
                </Alert>
            ) : null}
        </>
    );
}

/** One label/value line inside a totals card. */
function StatRow({ label, value }: { label: string; value: string }) {
    return (
        <Group justify="space-between" gap="md">
            <Text size="12.5px" c="dark.2" fw={600}>
                {label}
            </Text>
            <Text size="13px" c="dark.1" fw={600}>
                {value}
            </Text>
        </Group>
    );
}

/**
 * One cell in the metrics grid.
 *
 * `hint` exists because several of these figures are easy to misread — the share percentages
 * are of the member's own activity rather than the server's, and "first seen" is the bot's
 * record rather than Discord's join date. A dashboard that lets an operator assume otherwise
 * is worse than one that says which.
 */
function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
    const labelText = (
        <Text
            size="11px"
            c="dark.2"
            fw={700}
            tt="uppercase"
            style={hint ? { cursor: 'help', textDecoration: 'underline dotted' } : undefined}
        >
            {label}
        </Text>
    );

    return (
        <div>
            {hint ? (
                <Tooltip label={hint} multiline w={260} withArrow>
                    {labelText}
                </Tooltip>
            ) : (
                labelText
            )}
            <Text size="16px" fw={700} lh={1.3}>
                {value}
            </Text>
        </div>
    );
}

function BackToLeaderboard() {
    return (
        <Button
            component={Link}
            to="/leveling"
            variant="default"
            size="xs"
            leftSection={<IconChevronLeft size={14} />}
        >
            Back to the leaderboard
        </Button>
    );
}
