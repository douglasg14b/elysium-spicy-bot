/**
 * The server's warnings — active, expired and released — as a record a mod can work from:
 * filter it, open one, issue, edit and release (`docs/plans/warnings-in-the-dashboard.md` §4).
 *
 * Shaped after `TicketsListPage` deliberately — same header, counts strip, filter card and
 * results card — so moving between the two costs nobody a re-read.
 *
 * **Every decision worth testing lives outside this file**: `warningFilters` owns what the
 * filter means as query parameters, `warningPresentation` how a warning and its people are
 * written and what an empty table says, `warningForm` the dialog's rules. The page is wiring.
 *
 * **Search is the server's**, debounced into `listWarnings`: the list is capped, so narrowing
 * in the browser would only ever search the newest 200.
 */

import { useEffect, useState } from 'react';
import {
    Alert,
    Badge,
    Button,
    Card,
    Center,
    CloseButton,
    Group,
    Loader,
    SegmentedControl,
    Stack,
    Table,
    Text,
    TextInput,
    Title,
    Tooltip,
    UnstyledButton,
} from '@mantine/core';
import { IconAlertTriangle, IconPlus, IconSearch, IconSettings, IconShieldHalf } from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listWarningsOptions, type Warning } from '@brattybot/web-sdk';
import { loadErrorMessage } from '../api/loadErrorMessage';
import { useGuilds } from '../guilds/GuildContext';
import { CountTile } from '../layout/CountTile';
import type { MemberNames } from '../members/memberNames';
import { useMemberNames } from '../members/useMemberNames';
import { PAGE_MAX_WIDTH } from '../theme';
import { ReleaseWarningModal } from '../warnings/ReleaseWarningModal';
import { WarningDrawer } from '../warnings/WarningDrawer';
import { WarningFormModal, type WarningFormMode } from '../warnings/WarningFormModal';
import {
    DEFAULT_WARNING_FILTER,
    toListFilter,
    type WarningFilterState,
    type WarningStatusFilter,
} from '../warnings/warningFilters';
import {
    emptyListCopy,
    formatWarningDay,
    WARNING_STATUS_PRESENTATION,
    warningPeopleIds,
    warningPersonLabel,
} from '../warnings/warningPresentation';

/** How long a keystroke waits before it becomes a request. */
const SEARCH_DEBOUNCE_MS = 300;

/** The list route's own cap on `search` (`warningRoutes.ts`); nothing on a warning is longer. */
const WARNING_SEARCH_MAX_LENGTH = 100;

/** One reference for "no rows yet", so an unloaded list does not hand a new array to every render. */
const NO_WARNINGS: readonly Warning[] = [];

const STATUS_SEGMENTS: readonly { readonly value: WarningStatusFilter; readonly label: string }[] = [
    { value: 'active', label: 'Active' },
    { value: 'expired', label: 'Expired' },
    { value: 'released', label: 'Released' },
    { value: 'all', label: 'All' },
];

export function WarningsListPage() {
    const { selected, loading: guildsLoading } = useGuilds();

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

    // Keyed by server, so switching servers drops the filters, the drawer and any open dialog.
    return <WarningsList key={selected.id} guildId={selected.id} guildName={selected.name} />;
}

interface WarningsListProps {
    readonly guildId: string;
    readonly guildName: string;
}

function WarningsList({ guildId, guildName }: WarningsListProps) {
    const [filter, setFilter] = useState<WarningFilterState>(DEFAULT_WARNING_FILTER);
    /*
     * The input's own value, separate from the filter in force: they diverge for the length
     * of the debounce, and conflating them means a request per keystroke or a lagging input.
     */
    const [searchDraft, setSearchDraft] = useState(DEFAULT_WARNING_FILTER.search);
    /*
     * The drawer's warning, by slug, read from the list on every render — so a write's
     * re-read shows in the drawer, and a warning the filter no longer holds closes it rather
     * than leaving an old copy on screen. Cleared by every filter change (`changeFilter`), or
     * a warning that left the list — released from Active, say — would open the drawer again
     * by itself on the next filter that holds it.
     */
    const [openSlug, setOpenSlug] = useState<string | null>(null);
    /* The dialogs hold the warning as they opened on it: an edit's base is what was loaded. */
    const [formMode, setFormMode] = useState<WarningFormMode | null>(null);
    const [releasing, setReleasing] = useState<Warning | null>(null);

    /*
     * Cached per filter, so a late answer for a filter the operator has left lands in that
     * filter's entry. `keepPreviousData` keeps rows on screen while a new filter loads; only
     * the first read replaces the table with a spinner.
     */
    const listQuery = useQuery({
        ...listWarningsOptions({ path: { guildId }, query: toListFilter(filter) }),
        placeholderData: keepPreviousData,
    });
    const warnings = listQuery.data?.warnings ?? NO_WARNINGS;
    const counts = listQuery.data?.counts ?? null;
    const truncated = listQuery.data?.truncated ?? false;
    const loading = listQuery.isPending;
    const error = loadErrorMessage(listQuery.error, 'Failed to load warnings');
    const searching = searchDraft !== filter.search || listQuery.isPlaceholderData;

    const openWarning = openSlug ? (warnings.find((warning) => warning.slug === openSlug) ?? null) : null;

    /*
     * Everybody the page names — every row's people, and the member the list is narrowed to,
     * who may have no row on screen — in one request. The drawer and the dialogs show only
     * people from these rows, so they read the same answer.
     */
    const names = useMemberNames(guildId, [
        ...warnings.flatMap(warningPeopleIds),
        ...(filter.member ? [filter.member.id] : []),
    ]);

    /** Every change to the filter goes through here, so the drawer's slug never outlives the list it was opened from. */
    function changeFilter(update: (current: WarningFilterState) => WarningFilterState): void {
        setFilter(update);
        setOpenSlug(null);
    }

    useEffect(() => {
        if (searchDraft === filter.search) return;
        const timer = setTimeout(() => {
            setFilter((current) => ({ ...current, search: searchDraft }));
            setOpenSlug(null);
        }, SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [searchDraft, filter.search]);

    function applyStatus(status: WarningStatusFilter): void {
        changeFilter((current) => ({ ...current, status }));
    }

    function clearFilters(): void {
        changeFilter(() => DEFAULT_WARNING_FILTER);
        setSearchDraft(DEFAULT_WARNING_FILTER.search);
    }

    const empty = emptyListCopy(filter, counts);
    /*
     * Status only when the list mixes them. Filtered to one, every row would wear the same
     * badge the segmented control already says — a marker on every row carries nothing.
     */
    const showStatus = filter.status === 'all';
    const filterMemberLabel = filter.member ? warningPersonLabel(filter.member, names) : null;

    return (
        <Stack gap="lg" maw={PAGE_MAX_WIDTH}>
            <div>
                <Text size="12.5px" c="dark.2">
                    <Text span c="dark.1" fw={600}>
                        {guildName}
                    </Text>{' '}
                    › Configure › Warnings
                </Text>
                <Group justify="space-between" align="flex-end" mt={4} wrap="wrap">
                    <div>
                        <Group gap={10}>
                            <IconShieldHalf size={22} color="var(--mantine-color-brand-6)" />
                            <Title order={1} size="24px">
                                Warnings
                            </Title>
                        </Group>
                        <Text c="dimmed" size="13.5px" mt={4} maw={560}>
                            Who crossed which line, who caught them, and who got let off. Issue, amend and
                            release from here — every move lands in the mod log with receipts.
                        </Text>
                    </div>
                    <Group gap="sm">
                        <Button
                            component={Link}
                            to="/warnings/config"
                            variant="default"
                            leftSection={<IconSettings size={16} />}
                        >
                            Warning settings
                        </Button>
                        <Button
                            color="brand"
                            leftSection={<IconPlus size={16} />}
                            onClick={() => setFormMode({ kind: 'issue' })}
                        >
                            Issue warning
                        </Button>
                    </Group>
                </Group>
            </div>

            {/* Server-wide counts, said as such: they do not move when the filters do. */}
            <Group gap="sm" wrap="wrap">
                {counts ? (
                    <>
                        <CountTile
                            label="Active"
                            value={counts.active}
                            active={filter.status === 'active'}
                            onClick={() => applyStatus('active')}
                        />
                        <CountTile
                            label="Expired"
                            value={counts.expired}
                            active={filter.status === 'expired'}
                            onClick={() => applyStatus('expired')}
                        />
                        <CountTile
                            label="Released"
                            value={counts.released}
                            active={filter.status === 'released'}
                            onClick={() => applyStatus('released')}
                        />
                    </>
                ) : null}
                <Text size="11.5px" c="dark.2" style={{ alignSelf: 'center' }}>
                    Totals for the whole server — click one to filter by it.
                </Text>
            </Group>

            <Card p="md">
                <Group gap="md" align="center" wrap="wrap">
                    <SegmentedControl
                        size="xs"
                        value={filter.status}
                        onChange={(value) => applyStatus(value as WarningStatusFilter)}
                        data={[...STATUS_SEGMENTS]}
                    />
                    {/*
                     * A badge with its own close button rather than Mantine's `Pill`, whose
                     * remove button is hidden from assistive tech and unreachable by keyboard.
                     */}
                    {filterMemberLabel !== null ? (
                        <Badge
                            size="lg"
                            variant="light"
                            color="brand"
                            radius="sm"
                            tt="none"
                            pr={4}
                            maw={260}
                            rightSection={
                                <CloseButton
                                    size="xs"
                                    variant="transparent"
                                    c="brand.2"
                                    aria-label={`Stop filtering to ${filterMemberLabel}`}
                                    onClick={() => changeFilter((current) => ({ ...current, member: null }))}
                                />
                            }
                        >
                            Only {filterMemberLabel}
                        </Badge>
                    ) : null}
                    {/*
                     * Never `disabled` while a request is in flight: fetch-on-keystroke plus
                     * `disabled` hands focus to the body, and the next character goes nowhere.
                     * The placeholder names what the server matches — the start of each.
                     */}
                    <TextInput
                        size="xs"
                        flex="1 1 220px"
                        miw={220}
                        aria-label="Search warnings"
                        // The route refuses anything longer, and a refused list replaces the table.
                        maxLength={WARNING_SEARCH_MAX_LENGTH}
                        placeholder="Slug, rule, or a member's or mod's name"
                        leftSection={<IconSearch size={14} />}
                        rightSection={
                            searching ? (
                                <Loader size={12} color="brand" />
                            ) : searchDraft ? (
                                <CloseButton
                                    size="sm"
                                    aria-label="Clear search"
                                    onClick={() => setSearchDraft('')}
                                />
                            ) : null
                        }
                        value={searchDraft}
                        onChange={(event) => setSearchDraft(event.currentTarget.value)}
                    />
                </Group>
            </Card>

            <Card p={0} style={{ overflow: 'hidden' }}>
                {loading && warnings.length === 0 ? (
                    <Center py="xl">
                        <Loader color="brand" size="sm" />
                    </Center>
                ) : error ? (
                    <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Couldn't load warnings" m="md">
                        {error}
                    </Alert>
                ) : warnings.length === 0 ? (
                    <Stack align="center" gap={6} py={48} px="md">
                        <IconShieldHalf size={28} color="var(--mantine-color-dark-3)" />
                        <Text fw={700} size="15px">
                            {empty.title}
                        </Text>
                        <Text c="dimmed" size="13px" ta="center" maw={440}>
                            {empty.body}
                        </Text>
                        {empty.action === 'clear' ? (
                            <Button mt="sm" variant="default" onClick={clearFilters}>
                                Clear filters
                            </Button>
                        ) : (
                            <Button
                                mt="sm"
                                variant="default"
                                leftSection={<IconPlus size={16} />}
                                onClick={() => setFormMode({ kind: 'issue' })}
                            >
                                Issue a warning
                            </Button>
                        )}
                    </Stack>
                ) : (
                    // Scrolls below a 1280 laptop's content width rather than squeezing columns.
                    <Table.ScrollContainer minWidth={860}>
                        <Table layout="fixed" verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
                            <Table.Thead>
                                <Table.Tr>
                                    {/* Wide enough for a bare 19-digit id, shown for a row with no recorded name. */}
                                    <Table.Th w={180}>Member</Table.Th>
                                    <Table.Th>Rule</Table.Th>
                                    <Table.Th w={115}>Issued</Table.Th>
                                    <Table.Th w={115}>Drops off</Table.Th>
                                    <Table.Th w={165}>Issued by</Table.Th>
                                    {showStatus ? <Table.Th w={100}>Status</Table.Th> : null}
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {warnings.map((warning) => (
                                    <WarningRow
                                        key={warning.slug}
                                        warning={warning}
                                        names={names}
                                        showStatus={showStatus}
                                        onOpen={() => setOpenSlug(warning.slug)}
                                        onFilterToMember={() =>
                                            changeFilter((current) => ({
                                                ...current,
                                                member: {
                                                    id: warning.member.id,
                                                    name: warningPersonLabel(warning.member, names),
                                                },
                                            }))
                                        }
                                    />
                                ))}
                            </Table.Tbody>
                        </Table>
                    </Table.ScrollContainer>
                )}

                {/* A capped table that looks complete is a lie a mod acts on. */}
                {truncated && !loading && !error ? (
                    <Group justify="center" py="sm" px="md" style={{ borderTop: '1px solid var(--mantine-color-dark-4)' }}>
                        <Text size="12.5px" c="dark.2" ta="center">
                            Showing the newest {warnings.length} — narrow the search to see the rest.
                        </Text>
                    </Group>
                ) : null}
            </Card>

            <WarningDrawer
                warning={openWarning}
                names={names}
                onClose={() => setOpenSlug(null)}
                onEdit={(warning) => setFormMode({ kind: 'edit', warning })}
                onRelease={setReleasing}
            />
            <WarningFormModal guildId={guildId} mode={formMode} names={names} onClose={() => setFormMode(null)} />
            <ReleaseWarningModal guildId={guildId} warning={releasing} names={names} onClose={() => setReleasing(null)} />
        </Stack>
    );
}

interface WarningRowProps {
    readonly warning: Warning;
    readonly names: MemberNames;
    readonly showStatus: boolean;
    readonly onOpen: () => void;
    readonly onFilterToMember: () => void;
}

/** One warning in the table. The row opens the drawer; the member's name filters to them. */
function WarningRow({ warning, names, showStatus, onOpen, onFilterToMember }: WarningRowProps) {
    const member = warningPersonLabel(warning.member, names);
    const issuer = warningPersonLabel(warning.issuedBy, names);
    const status = WARNING_STATUS_PRESENTATION[warning.status];

    return (
        <Table.Tr style={{ cursor: 'pointer' }} onClick={onOpen}>
            <Table.Td>
                <Tooltip label={`Only ${member}'s warnings`} withArrow openDelay={300}>
                    <UnstyledButton
                        // Said, not only shown on hover: the name filters rather than opens.
                        aria-label={`Only ${member}'s warnings`}
                        // The row opens the drawer; this must not also.
                        onClick={(event) => {
                            event.stopPropagation();
                            onFilterToMember();
                        }}
                        style={{ maxWidth: '100%' }}
                    >
                        {/* `lh` set: the button's own line height clipped an underscore's descender. */}
                        <Text size="13px" fw={600} c="brand.4" lh={1.45} truncate="end">
                            {member}
                        </Text>
                    </UnstyledButton>
                </Tooltip>
            </Table.Td>
            <Table.Td>
                {/*
                 * A real button, so the drawer — and Edit and Release in it — can be reached by
                 * keyboard; the row's own click is for the mouse. Stops the click reaching the
                 * row, which would open the drawer a second time.
                 */}
                <UnstyledButton
                    aria-label={`Open ${warning.slug}`}
                    onClick={(event) => {
                        event.stopPropagation();
                        onOpen();
                    }}
                    style={{ display: 'block', maxWidth: '100%', textAlign: 'left' }}
                >
                    <Text size="13.5px" fw={600} lineClamp={1}>
                        {warning.rule}
                    </Text>
                    <Text ff="monospace" size="11.5px" c="dark.2" lineClamp={1}>
                        {warning.slug}
                    </Text>
                </UnstyledButton>
            </Table.Td>
            <Table.Td>
                <Text size="12.5px" c="dark.1">
                    {formatWarningDay(warning.issuedOn)}
                </Text>
            </Table.Td>
            <Table.Td>
                <Text size="12.5px" c="dark.1">
                    {formatWarningDay(warning.dropsOffOn)}
                </Text>
            </Table.Td>
            <Table.Td>
                <Tooltip label={issuer} multiline w={250} withArrow>
                    <Text size="12.5px" c="dark.2" lineClamp={1}>
                        {issuer}
                    </Text>
                </Tooltip>
            </Table.Td>
            {showStatus ? (
                <Table.Td>
                    <Badge variant="light" color={status.tone} radius="sm">
                        {status.label}
                    </Badge>
                </Table.Td>
            ) : null}
        </Table.Tr>
    );
}
