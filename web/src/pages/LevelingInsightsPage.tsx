/**
 * The server, read as a shape rather than a ranking — who gets how far, how long it takes
 * them, and how lopsided the XP actually is.
 *
 * Shaped after `LevelingUserPage`: same generation-counter read, same loading → error → empty
 * chain, same `PAGE_MAX_WIDTH`, same breadcrumb block, same `Card p="lg"` sections, and the
 * tiles strip is `LevelingPage`'s `CountTile` — local here, as it is on both other pages, plus a
 * required `hint` for the reason its own comment gives.
 *
 * **Every scale lives in `levelingInsights`.** There are no `.test.tsx` files in this repo — no
 * jsdom — so a bar height computed in JSX is a bar height nothing can test, and almost every
 * number on this page is a statistic that looks plausible when it is wrong.
 *
 * **Four figures here are easy to misrepresent, and the page says so out loud:**
 * - `topOnePercent` overlaps `topQuarter`, so the cohort table draws **no total row**. Summing
 *   the four counts over-counts the server by the size of the spotlight.
 * - A `thin` progression point is fewer than ten members — one person's climb is marked, not
 *   averaged into a claim about a typical one.
 * - Cohorts rank by XP **within this server**, so "top quarter" is busiest here, not busy.
 * - `medianActiveDays` counts days a member earned something, not days since they joined.
 *
 * The **503** is not an error state. It means the guild is too large to scan, which is a
 * capacity answer the server gives on purpose, and a red "something went wrong" panel would
 * send an operator looking for a fault that does not exist.
 */

import { useEffect, useRef, useState } from 'react';
import {
    Alert,
    Badge,
    Card,
    Center,
    Group,
    Loader,
    Stack,
    Table,
    Text,
    Title,
    Tooltip,
} from '@mantine/core';
import {
    IconAlertTriangle,
    IconChartHistogram,
    IconHourglassHigh,
    IconTrendingUp,
} from '@tabler/icons-react';
import { ApiError } from '../api/client';
import { getLevelingInsights } from '../api/leveling';
import type { LevelingCohortSummary, LevelingInsightsBody } from '../api/types';
import { LevelingTabs } from '../leveling/LevelingTabs';
import { ChartBar } from '../leveling/ChartBar';
// The row height comes from the chart module that owns it — and owns the comment explaining why
// the bar floor and the empty-bar hairline have to be judged against each other.
import { CHART_HEIGHT_PX } from '../leveling/levelingChart';
import {
    COHORT_PRESENTATION,
    PROGRESSION_HEIGHT,
    PROGRESSION_MIN_LEVEL,
    PROGRESSION_WIDTH,
    THIN_COHORT_MEMBERS,
    levelReachView,
    progressionView,
    xpDistributionView,
} from '../leveling/levelingInsights';
import type {
    LevelReachView,
    ProgressionView,
    XpDistributionView,
} from '../leveling/levelingInsights';
import { formatMoment, formatMomentWithTime } from '../leveling/levelingPresentation';
import { useGuilds } from '../guilds/GuildContext';
import { PAGE_MAX_WIDTH } from '../theme';

export function LevelingInsightsPage() {
    const { selected, loading: guildsLoading } = useGuilds();

    const [insights, setInsights] = useState<LevelingInsightsBody | null>(null);
    const [error, setError] = useState<string | null>(null);
    /*
     * The refusal, held separately from `error`.
     *
     * A 503 here means the guild is too big to scan — nothing is broken and there is nothing to
     * retry differently — so it gets its own panel rather than the red one. Collapsing the two
     * into a single string would lose the distinction the server went out of its way to make.
     */
    const [refusal, setRefusal] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const guildId = selected?.id;

    /*
     * A generation counter rather than a per-effect `cancelled` boolean, matching both other
     * leveling pages. The guild can be switched twice in quick succession and this report is
     * the slowest read in the dashboard — a cold one scans every logged XP day — so the first
     * guild's response landing after the second's is the likely case here, not the exotic one.
     */
    const readGeneration = useRef(0);

    useEffect(() => {
        if (!guildId) {
            // Lowered rather than left alone: `loading` starts true so the first paint is a
            // spinner, and bailing without clearing it spins forever with nothing to say why.
            setLoading(false);
            return;
        }
        const generation = ++readGeneration.current;
        void (async () => {
            setLoading(true);
            setError(null);
            setRefusal(null);
            /*
             * Cleared, unlike `LevelingUserPage`, and the difference is the subject rather than
             * a preference. There the refetch trigger is a period switch on the *same* member,
             * so holding the previous frame reads as a window changing; here the read takes no
             * parameter but the guild, so a refetch can only mean the server being described
             * changed. `selected.name` in the breadcrumb updates synchronously, so keeping the
             * old report would attribute one guild's every figure to another for as long as the
             * slowest read in the dashboard takes — with nothing on screen saying so.
             */
            setInsights(null);
            try {
                const loaded = await getLevelingInsights(guildId);
                if (generation === readGeneration.current) setInsights(loaded);
            } catch (err) {
                if (generation !== readGeneration.current) return;
                /*
                 * The status is what separates the two, not the message text. Matching on
                 * wording would break the moment the server rephrases its refusal, and the
                 * server's sentence names the event count and the ceiling — figures an operator
                 * can act on — so it is shown verbatim rather than replaced.
                 */
                if (err instanceof ApiError && err.status === 503) {
                    setRefusal(err.message);
                } else {
                    setError(err instanceof ApiError ? err.message : 'Failed to load the insights report');
                }
            } finally {
                if (generation === readGeneration.current) setLoading(false);
            }
        })();
    }, [guildId]);

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

    return (
        <Stack gap="lg" maw={PAGE_MAX_WIDTH}>
            <div>
                <Text size="12.5px" c="dark.2">
                    <Text span c="dark.1" fw={600}>
                        {selected.name}
                    </Text>{' '}
                    › Configure › Leveling › Insights
                </Text>
                <Group gap={10} mt={4}>
                    <IconChartHistogram size={22} color="var(--mantine-color-brand-6)" />
                    <Title order={1} size="24px">
                        Insights
                    </Title>
                </Group>
                <Text c="dimmed" size="13.5px" mt={4} maw={620}>
                    The shape of your server rather than its pecking order: how far people
                    actually get, how long the climb takes each sort of member, and how badly the
                    XP is hoarded. Spoiler — it is hoarded.
                </Text>
            </div>

            <LevelingTabs />

            {loading && !insights ? (
                <Center py="xl">
                    <Loader color="brand" size="sm" />
                </Center>
            ) : refusal ? (
                /*
                 * Grey and explanatory, not red. This is the server saying "no" on purpose:
                 * scanning this much history would stall the bot for everybody, and an operator
                 * reading a failure here would go hunting for a bug instead of understanding
                 * that their server is simply enormous.
                 */
                <Alert
                    color="gray"
                    icon={<IconHourglassHigh size={16} />}
                    title="Too much history to crunch"
                >
                    <Stack gap="xs" align="flex-start">
                        <Text size="13.5px">{refusal}</Text>
                        <Text size="12.5px" c="dark.2">
                            Nothing is broken and there is nothing to fix. The leaderboard still
                            works — it reads the stored progress rows rather than replaying every
                            XP event ever logged. Congratulations on the traffic, by the way.
                        </Text>
                    </Stack>
                </Alert>
            ) : error ? (
                <Alert
                    color="red"
                    icon={<IconAlertTriangle size={16} />}
                    title="Couldn't load the insights report"
                >
                    {error}
                </Alert>
            ) : insights ? (
                <LoadedInsights insights={insights} />
            ) : null}
        </Stack>
    );
}

/**
 * The report once there is one.
 *
 * Split out so `insights` is non-null throughout rather than optional-chained in fifty places,
 * and so all three chart scales are computed **once** at the top. Recomputing a scale beside
 * each thing that draws it is how a caption and its bars end up disagreeing after somebody
 * edits one of them.
 */
function LoadedInsights({ insights }: { insights: LevelingInsightsBody }) {
    const reach = levelReachView(insights.levelReach);
    const progression = progressionView(insights.cohorts);
    const distribution = insights.xpDistribution ? xpDistributionView(insights.xpDistribution) : null;

    /*
     * Nobody tracked is the one genuine empty state: every figure below is legitimately zero,
     * every array is empty, and `xpDistribution` is null. Three empty charts and a table of
     * dashes would read as a broken page rather than as a quiet server.
     */
    if (insights.trackedMembers === 0) {
        return (
            <>
                <FreshnessLine insights={insights} />
                <Card p="lg">
                    <Stack align="center" gap={6} py={40} px="md">
                        <IconTrendingUp size={28} color="var(--mantine-color-dark-3)" />
                        <Text fw={700} size="15px">
                            Nothing to analyse yet
                        </Text>
                        <Text c="dimmed" size="13px" ta="center" maw={460}>
                            Not one member has earned a single XP, so there is no curve to plot and
                            no cohorts to compare. Either the server is brand new, leveling has
                            been switched off the whole time, or everyone here is a spectator.
                        </Text>
                    </Stack>
                </Card>
            </>
        );
    }

    return (
        <>
            <FreshnessLine insights={insights} />

            {/*
             * The mean/median gap leads, because it is the single most useful figure here: on a
             * server where the average is nine times the typical member, "average XP" describes
             * nobody at all, and an operator quoting it would be quoting their loudest fifteen
             * people.
             */}
            <Group gap="sm" wrap="wrap">
                <CountTile
                    label="Tracked members"
                    value={insights.trackedMembers.toLocaleString()}
                    hint="Members with at least one logged XP event. Not your member count — lurkers who have never posted are not in here."
                />
                <CountTile
                    label="Top level"
                    value={insights.topLevel === null ? '—' : insights.topLevel.toLocaleString()}
                    hint="The highest level anybody has actually reached, uncapped. The reach curve below can stop lower than this — see the note under it."
                />
                {distribution ? (
                    <>
                        <CountTile
                            label="Typical XP"
                            value={distribution.typicalXp.toLocaleString()}
                            hint="The median member's XP. Half your tracked members have less than this, half have more — this is the one to quote."
                        />
                        <CountTile
                            label="Average XP"
                            value={distribution.meanXp.toLocaleString()}
                            hint="The mean. Dragged upwards by whoever never logs off, which is why it is shown next to the median rather than instead of it."
                        />
                    </>
                ) : null}
            </Group>

            {distribution?.meanExceedsTypical ? (
                <Alert color="brand" variant="light" title="The average is lying to you">
                    <Text size="13.5px">
                        The average member has {distribution.meanXp.toLocaleString()} XP. The{' '}
                        <Text span fw={700}>
                            typical
                        </Text>{' '}
                        one has {distribution.typicalXp.toLocaleString()} — the mean is{' '}
                        {distribution.meanToTypicalRatio}× the median, because a handful of people
                        are carrying the whole distribution on their backs. Quote the median when
                        somebody asks what normal looks like here.
                    </Text>
                </Alert>
            ) : null}

            <LevelReachCard reach={reach} insights={insights} />
            <ProgressionCard progression={progression} />
            <CohortTableCard cohorts={insights.cohorts} />
            {distribution ? <XpDistributionCard distribution={distribution} /> : null}
        </>
    );
}

/**
 * The reach curve, plus the note explaining when it is allowed to stop short of `topLevel`.
 *
 * Takes the whole body as well as the view, because the truncation note needs `topLevel` and
 * `levelReachTruncated` — both of which are facts about the report rather than about the scale,
 * so `levelReachView` has no business carrying them.
 */
function LevelReachCard({
    reach,
    insights,
}: {
    reach: LevelReachView;
    insights: LevelingInsightsBody;
}) {
    return (
        <Card p="lg">
            <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm">
                <div>
                    <Text fw={700} size="15px">
                        How far people actually get
                    </Text>
                    <Text size="12px" c="dark.2" maw={520}>
                        One bar per level, counting everybody who reached it{' '}
                        <Text span fs="italic">
                            or beyond
                        </Text>
                        . Starts at level {PROGRESSION_MIN_LEVEL} — level 1 is free. Bars are
                        scaled against the busiest level, not against your member count.
                    </Text>
                </div>
                {reach.highestLevel !== null ? (
                    <Text size="12px" c="dark.2" ta="right">
                        Curve ends at level {reach.highestLevel} · tallest bar{' '}
                        {reach.peakMembers.toLocaleString()} members
                    </Text>
                ) : null}
            </Group>

            {/*
             * Reachable, and not the same case as the page's `trackedMembers === 0` return:
             * `buildLevelReach` iterates from level 2 to the highest anybody reached, so a guild
             * whose members have all earned *something* but none of it enough to level has
             * tracked members and an empty curve. A new server spends its first day here.
             */}
            {reach.bars.length === 0 ? (
                <Text size="13px" c="dimmed" mt="md">
                    Nobody has made it past level 1 yet, so there is no curve to draw.
                </Text>
            ) : (
                <Group
                    gap={3}
                    mt="md"
                    align="flex-end"
                    wrap="nowrap"
                    h={CHART_HEIGHT_PX}
                    style={{ overflowX: 'auto' }}
                >
                    {reach.bars.map((bar) => (
                        <ChartBar
                            key={bar.level}
                            heightPercent={bar.heightPercent}
                            /*
                             * Always filled: `buildLevelReach` only emits levels somebody
                             * actually reached, and the counts are non-increasing, so a zero bar
                             * cannot occur on this chart. The hairline inside `ChartBar` is still
                             * what stops a floored bar rounding away to nothing.
                             */
                            filled
                            flex="1 1 8px"
                            minWidth={4}
                            label={`Level ${bar.level} — ${bar.membersReached.toLocaleString()} members (${bar.percentReached}% of tracked)`}
                        />
                    ))}
                </Group>
            )}

            {/*
             * The two figures are allowed to disagree, and this is the sentence that makes that
             * readable instead of alarming. `topLevel` is a fact about a member; the curve stops
             * at the report's tracked ceiling. The server sends the flag rather than leaving the
             * page to infer it by comparing them.
             */}
            {insights.levelReachTruncated ? (
                <Text size="12px" c="yellow.5" mt="sm" maw={620}>
                    The curve stops at level {reach.highestLevel} but somebody is on level{' '}
                    {insights.topLevel}. That is not a mistake — the report only tracks level
                    crossings up to a ceiling, and at least one person has climbed past it. The
                    tile above is the truth about them; the chart is the truth about everyone else.
                </Text>
            ) : null}
        </Card>
    );
}

/**
 * The four cohorts' climb, on one shared pair of axes.
 *
 * SVG polylines rather than a charting dependency, and every coordinate comes from
 * `progressionView` — the scaling is the part that can be wrong invisibly, so it is the part
 * that lives in a tested module.
 */
function ProgressionCard({ progression }: { progression: ProgressionView }) {
    return (
        <Card p="lg">
            <div>
                <Text fw={700} size="15px">
                    How long the climb takes
                </Text>
                <Text size="12px" c="dark.2" maw={620}>
                    Level reached across the bottom, typical days to get there up the side —
                    measured from each member&apos;s first activity. One line per band, all four on
                    the same axes so they can honestly be compared. A line that stops early is a
                    band that stopped levelling.
                </Text>
            </div>

            {progression.empty ? (
                <Text size="13px" c="dimmed" mt="md">
                    No band has reached level {PROGRESSION_MIN_LEVEL} yet, so there is no climb to
                    time.
                </Text>
            ) : (
                <>
                    <Group gap="md" mt="sm" wrap="wrap">
                        {progression.lines.map((line) => (
                            <Group gap={6} key={line.cohort} wrap="nowrap">
                                {/*
                                 * Drawn as an SVG stroke rather than a coloured div so the swatch
                                 * carries the line's dash pattern too. A solid block beside a
                                 * dashed line is not a legend — it is a colour key, which is the
                                 * thing the dashes exist to stop being the only channel.
                                 */}
                                <svg width={18} height={4} aria-hidden="true">
                                    <line
                                        x1={0}
                                        y1={2}
                                        x2={18}
                                        y2={2}
                                        stroke={line.presentation.color}
                                        strokeWidth={2.5}
                                        strokeDasharray={line.presentation.dash ?? undefined}
                                    />
                                </svg>
                                <Text size="12px" c="dark.1">
                                    {line.presentation.label}
                                </Text>
                                {/* A band with nobody in it keeps its legend entry, so the absence
                                    reads as "nobody" rather than a missing line. */}
                                {line.points.length === 0 ? (
                                    <Text size="11px" c="dark.3">
                                        (no data)
                                    </Text>
                                ) : null}
                            </Group>
                        ))}
                    </Group>

                    <div style={{ overflowX: 'auto', marginTop: 12 }}>
                        <svg
                            /*
                             * A viewBox plus `width: 100%`, so the plot module can work in fixed
                             * user units and the chart still scales to the card. The padding is on
                             * the viewBox rather than baked into the coordinates, which keeps the
                             * scaling arithmetic testable.
                             */
                            viewBox={`-4 -4 ${PROGRESSION_WIDTH + 8} ${PROGRESSION_HEIGHT + 8}`}
                            style={{
                                width: '100%',
                                minWidth: 420,
                                height: PROGRESSION_HEIGHT + 8,
                            }}
                            role="img"
                            aria-label="Median days to reach each level, by activity band"
                        >
                            {progression.lines.map((line) => (
                                <g key={line.cohort}>
                                    {line.polyline ? (
                                        <polyline
                                            points={line.polyline}
                                            fill="none"
                                            stroke={line.presentation.color}
                                            // A dash pattern as well as a hue, so the four bands
                                            // are separable without colour vision — the ramp
                                            // contains a red/green pair.
                                            strokeDasharray={line.presentation.dash ?? undefined}
                                            strokeWidth={2}
                                            strokeLinejoin="round"
                                            strokeLinecap="round"
                                        >
                                            <title>{line.presentation.label}</title>
                                        </polyline>
                                    ) : null}
                                    {line.points.map((point) => (
                                        <circle
                                            key={point.level}
                                            cx={point.x}
                                            cy={point.y}
                                            /*
                                             * A thin point is drawn hollow, dashed and larger — a
                                             * median from under ten people is one person's climb,
                                             * and it has to be distinguishable at a glance rather
                                             * than only in a tooltip.
                                             */
                                            r={point.thin ? 4 : 2.5}
                                            fill={
                                                point.thin
                                                    ? 'var(--mantine-color-dark-7)'
                                                    : line.presentation.color
                                            }
                                            stroke={line.presentation.color}
                                            strokeWidth={point.thin ? 1.5 : 0}
                                            strokeDasharray={point.thin ? '2 1.5' : undefined}
                                        >
                                            <title>
                                                {`${line.presentation.label} · level ${point.level} — ${point.medianDays.toLocaleString()} days, ${point.membersReached.toLocaleString()} members${point.thin ? ' (too few to trust)' : ''}`}
                                            </title>
                                        </circle>
                                    ))}
                                </g>
                            ))}
                        </svg>
                    </div>

                    {/*
                     * The left/right pair is the x axis and holds only levels. `maxDays` is the
                     * *vertical* domain, so it is stated on its own line and named as one —
                     * sitting it at the right-hand end of an x-axis row read as though the days
                     * belonged to the last level rather than to the tallest point on any line.
                     */}
                    <Group justify="space-between" mt={4} wrap="nowrap">
                        <Text size="11px" c="dark.3">
                            Level {PROGRESSION_MIN_LEVEL}
                        </Text>
                        <Text size="11px" c="dark.3">
                            Level {progression.maxLevel}
                        </Text>
                    </Group>
                    <Text size="11px" c="dark.3" mt={2}>
                        Vertical: 0 to {progression.maxDays.toLocaleString()} days — the top of the
                        plot is the slowest climb on any line.
                    </Text>

                    {/* The threshold is interpolated, not typed out: the bot owns it, and a
                        caption naming a number it no longer uses would be a lie that renders
                        perfectly. */}
                    {progression.anyThin ? (
                        <Text size="12px" c="yellow.5" mt="sm" maw={620}>
                            Hollow, dashed markers were reached by fewer than {THIN_COHORT_MEMBERS}{' '}
                            members in that band. A &quot;typical time to level 30&quot; computed
                            from three people is one person&apos;s grind wearing a median&apos;s
                            clothes — read those points as a hint, not a fact.
                        </Text>
                    ) : null}
                </>
            )}
        </Card>
    );
}

/**
 * The bands as a table, with **no total row** — see the footnote inside.
 *
 * Takes the cohorts rather than a view: every figure in here is the server's own median, printed
 * as sent, so there is nothing to scale and nothing for a view function to own.
 */
function CohortTableCard({ cohorts }: { cohorts: readonly LevelingCohortSummary[] }) {
    return (
        <Card p="lg">
            <div>
                <Text fw={700} size="15px">
                    The bands, side by side
                </Text>
                <Text size="12px" c="dark.2" maw={620}>
                    Ranked by XP{' '}
                    <Text span fw={700}>
                        within this server
                    </Text>{' '}
                    — &quot;top quarter&quot; means busiest here, not busy in general. A quiet
                    server&apos;s top quarter might out-post nobody.
                </Text>
            </div>

            <Table verticalSpacing="sm" horizontalSpacing="md" mt="md">
                <Table.Thead>
                    <Table.Tr>
                        <Table.Th>Band</Table.Th>
                        <Table.Th w={110}>Members</Table.Th>
                        <Table.Th w={130}>Median XP</Table.Th>
                        <Table.Th w={120}>Median level</Table.Th>
                        <Table.Th w={150}>Median active days</Table.Th>
                    </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                    {cohorts.map((cohort) => (
                        <CohortRow key={cohort.cohort} cohort={cohort} />
                    ))}
                </Table.Tbody>
                {/*
                 * No total row, and no stacked chart, deliberately. `topOnePercent` is a spotlight
                 * on the tail rather than a fifth exclusive band — its members are counted in
                 * `topQuarter` as well — so the four counts do not partition the server and any
                 * total drawn from them would over-count it. The footnote below says so rather
                 * than a tfoot quietly adding them up.
                 */}
            </Table>

            <Text size="12px" c="dark.2" mt="sm" maw={620}>
                Don&apos;t add the member counts up. The top 1% are also counted in the top quarter
                — they are a spotlight on the extreme tail, not a separate band, because folding
                their numbers into the top quarter&apos;s median hides both stories. Only the first
                three rows are exclusive.
            </Text>
        </Card>
    );
}

/** The decile bars, and the long tail they exist to make visible. */
function XpDistributionCard({ distribution }: { distribution: XpDistributionView }) {
    return (
        <Card p="lg">
            <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm">
                <div>
                    <Text fw={700} size="15px">
                        Where the XP actually sits
                    </Text>
                    {/*
                     * The second sentence is conditional, because on a small guild it is not
                     * true: the server's ninth cut clamps onto the last member once ten or fewer
                     * are tracked, so the tallest bar *is* the top member — the same number
                     * printed beside the chart. Claiming the scale excludes them would be
                     * contradicted on screen, by the figure next to it.
                     */}
                    <Text size="12px" c="dark.2" maw={520}>
                        Nine bars, one per 10% mark: the XP held by the member at that point in the
                        ranking.{' '}
                        {distribution.topCutIsTopMember
                            ? 'With this few members tracked, the top cut is your top member — so the tallest bar is them, and everyone else is however far behind they look.'
                            : 'Scaled against the 90th percentile — not against your top member, whose bar would flatten every other one into the floor.'}
                    </Text>
                </div>
                <Text size="12px" c="dark.2" ta="right">
                    Top member {distribution.topMemberXp.toLocaleString()} XP
                </Text>
            </Group>

            {distribution.bars.length === 0 ? (
                <Text size="13px" c="dimmed" mt="md">
                    Not enough members to cut into deciles yet.
                </Text>
            ) : (
                <>
                    <Group gap={8} mt="md" align="flex-end" wrap="nowrap" h={CHART_HEIGHT_PX}>
                        {distribution.bars.map((bar) => (
                            <ChartBar
                                key={bar.decile}
                                heightPercent={bar.heightPercent}
                                // Genuinely can be empty here, unlike the reach curve: a decile
                                // cut of zero is a real answer on a server where most members
                                // have never earned anything.
                                filled={bar.xp > 0}
                                flex="1"
                                label={`${bar.decile * 10}th percentile — ${bar.xp.toLocaleString()} XP`}
                            />
                        ))}
                    </Group>
                    <Group justify="space-between" mt={4}>
                        <Text size="11px" c="dark.3">
                            10th
                        </Text>
                        <Text size="11px" c="dark.3">
                            90th percentile
                        </Text>
                    </Group>
                    {/*
                     * Which sentence depends on whether there is a tail to point at. `allZero`
                     * means every cut is zero — but on a guild of ten or fewer the top cut *is*
                     * the top member, so their XP is zero too and there is nothing held above the
                     * 90th percentile to blame it on.
                     */}
                    {distribution.allZero ? (
                        <Text size="12px" c="dark.2" mt="sm">
                            {distribution.topMemberXp > 0
                                ? 'Every cut is zero: nine out of ten of your tracked members have earned nothing at all, and whatever XP exists is hoarded above the 90th percentile.'
                                : 'Every cut is zero, top member included. Everybody here is tracked and nobody has banked a thing — the bars are honest, the server is just quiet.'}
                        </Text>
                    ) : null}
                </>
            )}
        </Card>
    );
}

/** One band's row. Split out so the hint copy sits beside the figure it qualifies. */
function CohortRow({ cohort }: { cohort: LevelingCohortSummary }) {
    const presentation = COHORT_PRESENTATION[cohort.cohort];

    return (
        <Table.Tr>
            <Table.Td>
                <Group gap={8} wrap="nowrap">
                    <div
                        style={{
                            width: 10,
                            height: 10,
                            borderRadius: 3,
                            background: presentation.color,
                            flex: '0 0 auto',
                        }}
                    />
                    <Text size="13.5px" fw={600}>
                        {presentation.label}
                    </Text>
                    {presentation.overlapping ? (
                        <Tooltip
                            label="Also counted in the top quarter. A spotlight on the extreme tail, not a separate band — so this row does not add to the others."
                            multiline
                            w={260}
                            withArrow
                        >
                            <Badge size="xs" variant="light" color="yellow" radius="sm">
                                Overlaps
                            </Badge>
                        </Tooltip>
                    ) : null}
                </Group>
            </Table.Td>
            <Table.Td>
                <Text size="13px" fw={600}>
                    {cohort.memberCount.toLocaleString()}
                </Text>
            </Table.Td>
            <Table.Td>
                <Text size="13px" c="dark.1">
                    {cohort.medianTotalXp.toLocaleString()}
                </Text>
            </Table.Td>
            <Table.Td>
                <Text size="13px" c="dark.1">
                    {cohort.medianLevel.toLocaleString()}
                </Text>
            </Table.Td>
            <Table.Td>
                <Tooltip
                    label="Days this band's median member earned something — not days since they joined. Somebody here for a year who posts twice a month has a low number and is not inactive."
                    multiline
                    w={280}
                    withArrow
                >
                    <Text size="13px" c="dark.1" style={{ cursor: 'help', width: 'fit-content' }}>
                        {cohort.medianActiveDays.toLocaleString()}
                    </Text>
                </Tooltip>
            </Table.Td>
        </Table.Tr>
    );
}

/**
 * When the report was computed, and whether it was reheated.
 *
 * Said on every state that has a report, including the empty one: a cached empty answer and a
 * freshly computed empty answer are the same picture, and an operator who has just switched
 * leveling on deserves to know which of the two they are looking at before they conclude it
 * does not work.
 */
function FreshnessLine({ insights }: { insights: LevelingInsightsBody }) {
    return (
        <Group gap="xs" wrap="wrap">
            <Text size="11.5px" c="dark.2">
                As of {formatMomentWithTime(insights.computedAt)}
            </Text>
            {insights.cached ? (
                <Tooltip
                    label="Served from the bot's cache rather than recomputed for this page load. Scanning every logged XP event is expensive, so the report has a short shelf life."
                    multiline
                    w={280}
                    withArrow
                >
                    <Badge size="xs" variant="light" color="gray" radius="sm">
                        Cached
                    </Badge>
                </Tooltip>
            ) : null}
            {insights.firstActivityDate ? (
                <Text size="11.5px" c="dark.3">
                    · covering {formatMoment(insights.firstActivityDate)} →{' '}
                    {formatMoment(insights.lastActivityDate)}
                </Text>
            ) : null}
        </Group>
    );
}

/**
 * One number in the tiles strip.
 *
 * `hint` rather than a bare figure, because three of the four are routinely misread: tracked
 * members is not the member count, and the average is not the typical member.
 */
function CountTile({ label, value, hint }: { label: string; value: string; hint: string }) {
    return (
        <Tooltip label={hint} multiline w={280} withArrow>
            <Card p="xs" px="md" bg="dark.7" style={{ cursor: 'help' }}>
                <Text size="11px" c="dark.2" fw={700} tt="uppercase">
                    {label}
                </Text>
                <Text size="20px" fw={800} lh={1.2}>
                    {value}
                </Text>
            </Card>
        </Tooltip>
    );
}
