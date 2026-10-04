/**
 * The guild leaderboard — who has been talking, and how much it earned them.
 *
 * Shaped after `TicketsListPage` deliberately: same breadcrumb block, same tiles strip,
 * same `Card p={0}` + `Table`, same loading → error → empty chain, same truncation footer.
 * Moving between the two costs nobody a re-read.
 *
 * **Read-only, and not coy about it.** There is no write path for leveling config in the
 * bot — five of its columns are overwritten by `constants.ts` on every read — so when
 * leveling is switched off this page says so and points at Discord rather than offering a
 * toggle that would lie.
 *
 * **Every decision worth testing lives outside this file.** `memberPresentation` owns how
 * a person is written, `ACTIVITY_STATUS_PRESENTATION` owns the badge, and
 * `levelingPresentation` owns the formatting. Logic left in a component is logic only a
 * render can check; out there a unit test drives it.
 */

import {
    Alert,
    Avatar,
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
    IconMoodOff,
    IconTrendingUp,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { listLevelingOptions, type LevelingRankingRow } from '@brattybot/web-sdk';
import { loadErrorMessage } from '../api/loadErrorMessage';
import { LevelingTabs } from '../leveling/LevelingTabs';
import { leaderboardTotals } from '../leveling/levelingLeaderboard';
import { memberPresentation } from '../leveling/levelingMember';
import { formatMoment } from '../leveling/levelingPresentation';
import { useGuilds } from '../guilds/GuildContext';
import { PAGE_MAX_WIDTH } from '../theme';

/** Medals for the top three, because a leaderboard without them is a spreadsheet. */
const RANK_MEDALS: Readonly<Record<number, string>> = { 1: '🥇', 2: '🥈', 3: '🥉' };

/** One reference for "no rows yet", so an unloaded board does not hand a new array to every render. */
const NO_ENTRIES: readonly LevelingRankingRow[] = [];

export function LevelingPage() {
    const { selected, loading: guildsLoading } = useGuilds();
    const navigate = useNavigate();

    /*
     * The leaderboard, cached per guild. A guild switch reads the new guild's entry, so the
     * first guild's slower response can never be painted under the second guild's name.
     */
    const leaderboard = useQuery({
        ...listLevelingOptions({ path: { guildId: selected?.id ?? '' } }),
        enabled: !!selected,
    });
    const entries = leaderboard.data?.entries ?? NO_ENTRIES;
    const totalRankedMembers = leaderboard.data?.totalRankedMembers ?? 0;
    const truncated = leaderboard.data?.truncated ?? false;
    const enabled = leaderboard.data?.enabled ?? true;
    const loading = leaderboard.isPending;
    const error = loadErrorMessage(leaderboard.error, 'Failed to load the leaderboard');

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

    /*
     * Summed from the rows on screen, and labelled as such below. The server sends no
     * guild-wide totals for messages or reactions — only `totalRankedMembers` — so calling
     * these "server totals" beside a capped table would be a number an operator would quote
     * and be wrong about.
     */
    const { shownMessages, shownReactions, topLevel } = leaderboardTotals(entries);

    return (
        <Stack gap="lg" maw={PAGE_MAX_WIDTH}>
            <div>
                <Text size="12.5px" c="dark.2">
                    <Text span c="dark.1" fw={600}>
                        {selected.name}
                    </Text>{' '}
                    › Configure › Leveling
                </Text>
                <Group justify="space-between" align="flex-end" mt={4} wrap="wrap">
                    <div>
                        <Group gap={10}>
                            <IconTrendingUp size={22} color="var(--mantine-color-brand-6)" />
                            <Title order={1} size="24px">
                                Leveling
                            </Title>
                        </Group>
                        <Text c="dimmed" size="13.5px" mt={4} maw={560}>
                            Who the regulars actually are, ranked by XP earned. Click anyone for
                            the full breakdown of how they earned it — and how recently they
                            bothered.
                        </Text>
                    </div>
                </Group>
            </div>

            {/* The two views of leveling. Shared with the insights page so the highlight and the
                URL cannot disagree — see `LevelingTabs`. */}
            <LevelingTabs />

            {/*
             * Said before the table, not instead of it. Progress rows outlive the switch, so
             * a disabled guild still has a leaderboard worth looking at — it is simply
             * frozen. No toggle here: there is no write path, and a switch that did nothing
             * would be worse than a sentence that explains itself.
             */}
            {!loading && !error && !enabled ? (
                <Alert color="yellow" icon={<IconMoodOff size={16} />} title="Leveling is switched off">
                    Nobody is earning anything in this server right now. Whatever is below is
                    history — XP already banked, frozen where it stood. Turning it back on is a
                    Discord-side job:{' '}
                    <Text span ff="monospace">
                        /leveling-config enabled:true
                    </Text>
                    . This dashboard reads leveling, it doesn&apos;t rule it.
                </Alert>
            ) : null}

            {/*
             * `totalRankedMembers` is guild-wide and comes back regardless of the cap, so it
             * does not move when the table is truncated. The other three are explicitly the
             * shown rows' — see the caption.
             */}
            <Group gap="sm" wrap="wrap">
                <CountTile label="Ranked members" value={totalRankedMembers.toLocaleString()} />
                {/*
                 * `(shown)` like its two neighbours: this is a max over the rows in the table,
                 * and `level` is a stored column that can lag `totalXp`, so on a truncated board
                 * a member further down can in principle hold a higher level. The caption says
                 * three figures are table-scoped; the labels have to agree with it.
                 */}
                <CountTile label="Top level (shown)" value={topLevel.toLocaleString()} />
                <CountTile label="Messages (shown)" value={shownMessages.toLocaleString()} />
                <CountTile label="Reactions (shown)" value={shownReactions.toLocaleString()} />
                <Text size="11.5px" c="dark.2" style={{ alignSelf: 'center' }} maw={280}>
                    Ranked members is the whole server. The other three add up the rows in the
                    table below, which may be a slice of it.
                </Text>
            </Group>

            <Card p={0} style={{ overflow: 'hidden' }}>
                {/*
                 * Only the first read replaces the table with a spinner, matching the tickets
                 * list. There is nothing to re-filter here today, but the condition is the
                 * shape a reader of the other page expects and costs nothing to keep.
                 */}
                {loading && entries.length === 0 ? (
                    <Center py="xl">
                        <Loader color="brand" size="sm" />
                    </Center>
                ) : error ? (
                    <Alert
                        color="red"
                        icon={<IconAlertTriangle size={16} />}
                        title="Couldn't load the leaderboard"
                        m="md"
                    >
                        {error}
                    </Alert>
                ) : entries.length === 0 ? (
                    <Stack align="center" gap={6} py={48} px="md">
                        <IconTrendingUp size={28} color="var(--mantine-color-dark-3)" />
                        <Text fw={700} size="15px">
                            {enabled ? 'Nobody has earned a thing' : 'Nothing was ever earned'}
                        </Text>
                        <Text c="dimmed" size="13px" ta="center" maw={440}>
                            {enabled
                                ? 'Not one XP banked. Either this server is very new or everyone is lurking — reading, judging, contributing nothing.'
                                : 'Leveling has been off, so nothing was ever counted. Switch it on with /leveling-config in Discord and the lurkers will start showing up here.'}
                        </Text>
                    </Stack>
                ) : (
                    <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th w={70}>Rank</Table.Th>
                                <Table.Th>Member</Table.Th>
                                <Table.Th w={80}>Level</Table.Th>
                                <Table.Th w={110}>Total XP</Table.Th>
                                <Table.Th w={100}>Messages</Table.Th>
                                <Table.Th w={100}>Reactions</Table.Th>
                                <Table.Th w={130}>Last active</Table.Th>
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {entries.map((entry) => {
                                const person = memberPresentation(entry.member, entry.userId);
                                return (
                                    <Table.Tr
                                        key={entry.userId}
                                        style={{ cursor: 'pointer' }}
                                        onClick={() => navigate(`/leveling/${entry.userId}`)}
                                    >
                                        <Table.Td>
                                            <Group gap={6} wrap="nowrap">
                                                <Text size="13px" fw={700} ff="monospace">
                                                    {entry.rank}
                                                </Text>
                                                {RANK_MEDALS[entry.rank] ? (
                                                    <Text size="13px">
                                                        {RANK_MEDALS[entry.rank]}
                                                    </Text>
                                                ) : null}
                                            </Group>
                                        </Table.Td>
                                        <Table.Td>
                                            <Group gap={10} wrap="nowrap">
                                                <Avatar
                                                    src={person.avatarUrl ?? undefined}
                                                    radius="xl"
                                                    size={30}
                                                    color="brand"
                                                >
                                                    {person.monogram}
                                                </Avatar>
                                                <div style={{ overflow: 'hidden' }}>
                                                    <Group gap={6} wrap="nowrap">
                                                        <Text size="13.5px" fw={600} lineClamp={1}>
                                                            {person.name}
                                                        </Text>
                                                        {person.isBot ? (
                                                            <Badge
                                                                size="xs"
                                                                variant="light"
                                                                color="gray"
                                                                radius="sm"
                                                            >
                                                                Bot
                                                            </Badge>
                                                        ) : null}
                                                        {/*
                                                         * A departed member still holds their
                                                         * XP and still ranks, so the row stays
                                                         * — it just says why the name is an id.
                                                         */}
                                                        {person.departed ? (
                                                            <Tooltip
                                                                label="Discord no longer resolves this account in this server — they left, but the XP they earned is still on the board."
                                                                multiline
                                                                w={260}
                                                                withArrow
                                                            >
                                                                <Badge
                                                                    size="xs"
                                                                    variant="light"
                                                                    color="red"
                                                                    radius="sm"
                                                                >
                                                                    Gone
                                                                </Badge>
                                                            </Tooltip>
                                                        ) : null}
                                                    </Group>
                                                    {person.handle ? (
                                                        <Text size="11.5px" c="dark.2" lineClamp={1}>
                                                            @{person.handle}
                                                        </Text>
                                                    ) : null}
                                                </div>
                                            </Group>
                                        </Table.Td>
                                        <Table.Td>
                                            <Badge variant="light" color="brand" radius="sm">
                                                {entry.level}
                                            </Badge>
                                        </Table.Td>
                                        <Table.Td>
                                            <Text size="13px" fw={600}>
                                                {entry.totalXp.toLocaleString()}
                                            </Text>
                                        </Table.Td>
                                        <Table.Td>
                                            <Text size="12.5px" c="dark.1">
                                                {entry.messageCount.toLocaleString()}
                                            </Text>
                                        </Table.Td>
                                        <Table.Td>
                                            <Text size="12.5px" c="dark.1">
                                                {entry.reactionCount.toLocaleString()}
                                            </Text>
                                        </Table.Td>
                                        <Table.Td>
                                            <Text size="12.5px" c="dark.2">
                                                {formatMoment(entry.lastActiveAt)}
                                            </Text>
                                        </Table.Td>
                                    </Table.Tr>
                                );
                            })}
                        </Table.Tbody>
                    </Table>
                )}

                {/*
                 * Said out loud, because a capped table that looks complete is a lie an
                 * operator acts on. There is no filter to narrow this with — the endpoint
                 * takes no parameters — so the footer says where the rest is instead of
                 * offering a control that does not exist.
                 */}
                {truncated && !loading && !error ? (
                    <Group
                        justify="center"
                        py="sm"
                        px="md"
                        style={{ borderTop: '1px solid var(--mantine-color-dark-4)' }}
                    >
                        <Text size="12.5px" c="dark.2" ta="center">
                            Showing the top {entries.length} of{' '}
                            {totalRankedMembers.toLocaleString()} ranked members. The rest are
                            further down than this page goes — look them up individually with{' '}
                            <Text span ff="monospace">
                                /level
                            </Text>{' '}
                            in Discord.
                        </Text>
                    </Group>
                ) : null}
            </Card>
        </Stack>
    );
}

/** One number in the tiles strip. Not clickable: there is nothing to filter by. */
function CountTile({ label, value }: { label: string; value: string }) {
    return (
        <Card p="xs" px="md" bg="dark.7">
            <Text size="11px" c="dark.2" fw={700} tt="uppercase">
                {label}
            </Text>
            <Text size="20px" fw={800} lh={1.2}>
                {value}
            </Text>
        </Card>
    );
}
