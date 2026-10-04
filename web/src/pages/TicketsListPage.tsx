/**
 * The guild's tickets, as a list an operator can work from.
 *
 * Shaped after `JourneysListPage` deliberately — same breadcrumb block, same
 * `Card p={0}` + `Table`, same loading → error → empty chain — so moving between the two
 * costs nobody a re-read of where the row actions live.
 *
 * **Every decision worth testing lives outside this file.** `availableActions` owns which
 * buttons a row offers, `toListFilter` owns what the filter means as query parameters,
 * and `participantLabel` owns how a person is written. There are no `.test.tsx` files in
 * this repo — no jsdom — so logic left in a component is logic nothing can test, and the
 * page is kept to wiring on purpose.
 *
 * **Search is the server's.** The list is unpaginated, so narrowing in the browser would
 * mean shipping a guild's whole ticket history to hide most of it. Keystrokes are
 * debounced into `listTickets` instead.
 */

import { useEffect, useState } from 'react';
import {
    Alert,
    Badge,
    Button,
    Card,
    Center,
    Group,
    Loader,
    SegmentedControl,
    Select,
    Stack,
    Switch,
    Table,
    Text,
    TextInput,
    Title,
    Tooltip,
    UnstyledButton,
} from '@mantine/core';
import {
    IconAlertTriangle,
    IconSearch,
    IconSettings,
    IconTicket,
} from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { getTicketsConfigOptions, listTicketsOptions, type TicketSummary } from '@brattybot/web-sdk';
import { loadErrorMessage } from '../api/loadErrorMessage';
import { availableActions, TICKET_ACTION_PRESENTATION } from '../tickets/ticketActions';
import { useTicketAction } from '../tickets/useTicketAction';
import { formatTicketNumber, TICKET_STATUS_TONE } from '../tickets/ticketPresentation';
import {
    DEFAULT_TICKET_FILTER,
    toListFilter,
    typeFilterOptions,
    type TicketFilterState,
    type TicketStatusFilter,
} from '../tickets/ticketFilters';
import { participantLabel, optionalParticipantLabel } from '../tickets/participantLabel';
import { useGuilds } from '../guilds/GuildContext';
import { PAGE_MAX_WIDTH } from '../theme';

/** How long a keystroke waits before it becomes a request. */
const SEARCH_DEBOUNCE_MS = 300;

/** One reference for "no rows yet", so an unloaded list does not hand a new array to every render. */
const NO_TICKETS: readonly TicketSummary[] = [];

function formatUpdated(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
}

export function TicketsListPage() {
    const { selected, loading: guildsLoading } = useGuilds();
    const navigate = useNavigate();

    const [filter, setFilter] = useState<TicketFilterState>(DEFAULT_TICKET_FILTER);
    /*
     * The input's own value, separate from the filter that is actually in force. They
     * diverge for the length of the debounce, and conflating them would mean either a
     * request per keystroke or an input that lags behind the typing.
     */
    const [searchDraft, setSearchDraft] = useState(DEFAULT_TICKET_FILTER.search);

    const guildId = selected?.id;

    /*
     * The list, cached per guild and filter. The filter is the key, so a late answer for a
     * filter the operator has moved off lands in that filter's entry and can never leave the
     * table showing `open` tickets under a control reading "Closed".
     *
     * `keepPreviousData` keeps the rows on screen while a new filter loads: only the *first*
     * read replaces the table with a spinner, because blanking it on every debounce tick reads
     * as a page reload rather than a filter narrowing — and typing is when it would fire most.
     */
    const listPath = { guildId: guildId ?? '' };
    const listParams = toListFilter(filter);
    const listQuery = useQuery({
        ...listTicketsOptions({ path: listPath, query: listParams }),
        enabled: !!guildId,
        placeholderData: keepPreviousData,
    });
    const tickets = listQuery.data?.tickets ?? NO_TICKETS;
    const counts = listQuery.data?.counts ?? null;
    const truncated = listQuery.data?.truncated ?? false;
    const loading = listQuery.isPending;
    const error = loadErrorMessage(listQuery.error, 'Failed to load tickets');

    /*
     * The config. It is read for two things only — the type dropdown's labels and knowing
     * whether tickets are set up at all — neither of which changes while the operator
     * filters, so it is deliberately not part of the list's key.
     *
     * A failed read is non-fatal: the type dropdown falls back to "All types" and the list
     * still renders. The list's own error state covers a guild that is genuinely unreachable.
     */
    const configQuery = useQuery({
        ...getTicketsConfigOptions({ path: listPath }),
        enabled: !!guildId,
    });
    const config = configQuery.data ?? null;

    /*
     * The search box's loader: the typed text has not reached the filter yet, or the table
     * is still showing a previous filter's rows while the new one loads.
     */
    const searching = searchDraft !== filter.search || listQuery.isPlaceholderData;

    /*
     * The search term, debounced into the filter. Separate from the query above so the
     * non-text controls stay instant — nobody wants a 300ms wait after clicking a
     * segmented control.
     */
    useEffect(() => {
        if (searchDraft === filter.search) return;
        const timer = setTimeout(() => {
            setFilter((current) => ({ ...current, search: searchDraft }));
        }, SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [searchDraft, filter.search]);

    // Each action ends in a re-read of the list, never a patch of the row it returned: the
    // counts are guild-wide, and a closed ticket must leave an `open`-filtered table.
    const { acting, act } = useTicketAction(guildId);

    function applyStatus(status: TicketStatusFilter): void {
        setFilter((current) => ({ ...current, status, unclaimedOnly: false }));
    }

    function clearFilters(): void {
        setFilter(DEFAULT_TICKET_FILTER);
        setSearchDraft(DEFAULT_TICKET_FILTER.search);
    }

    // Whether anything is narrowing the list, which is what separates "this guild has no
    // tickets" from "your filters found none". They look identical otherwise, and an
    // operator cannot tell which one they are looking at.
    const filtersActive =
        filter.status !== DEFAULT_TICKET_FILTER.status ||
        filter.type !== null ||
        filter.unclaimedOnly ||
        filter.search.trim() !== '';

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
                    › Configure › Tickets
                </Text>
                <Group justify="space-between" align="flex-end" mt={4} wrap="wrap">
                    <div>
                        <Group gap={10}>
                            <IconTicket size={22} color="var(--mantine-color-brand-6)" />
                            <Title order={1} size="24px">
                                Tickets
                            </Title>
                        </Group>
                        <Text c="dimmed" size="13.5px" mt={4} maw={560}>
                            Who asked for help, who picked it up, and who has been ignoring the
                            queue. Claim, release and close from here — the conversation itself
                            stays in Discord.
                        </Text>
                    </div>
                    <Button
                        component={Link}
                        to="/tickets/config"
                        variant="default"
                        leftSection={<IconSettings size={16} />}
                    >
                        Ticket settings
                    </Button>
                </Group>
            </div>

            {/*
             * Guild-wide counts, said out loud as such. They come from a separate query
             * to the filtered list, so they do not move when the filters do — and a
             * strip that silently disagreed with the rows below it would read as a bug.
             */}
            <Group gap="sm" wrap="wrap">
                {counts ? (
                    <>
                        <CountTile
                            label="Open"
                            value={counts.open}
                            active={filter.status === 'open' && !filter.unclaimedOnly}
                            onClick={() => applyStatus('open')}
                        />
                        <CountTile
                            label="Unclaimed"
                            value={counts.unclaimed}
                            active={filter.unclaimedOnly}
                            onClick={() =>
                                setFilter((current) => ({
                                    ...current,
                                    status: 'open',
                                    unclaimedOnly: true,
                                }))
                            }
                        />
                        {/*
                         * `&& !unclaimedOnly` mirrors the Open tile. `applyStatus` clears
                         * `unclaimedOnly`, so the clause is unreachable today — stated anyway,
                         * because two tiles answering the same question two different ways is
                         * what reads as a bug to whoever edits this next.
                         */}
                        <CountTile
                            label="Closed"
                            value={counts.closed}
                            active={filter.status === 'closed' && !filter.unclaimedOnly}
                            onClick={() => applyStatus('closed')}
                        />
                    </>
                ) : null}
                {/*
                 * No Deleted tile, deliberately. `deleted` is a terminal archive state — the
                 * row survives so history stays answerable, not so anyone works it — and a
                 * tile inviting a click into an archive is not what a moderator opening this
                 * page needs. The Deleted *segment* still exists for looking something up,
                 * so the caption says which three the numbers cover rather than leaving an
                 * operator to wonder whether zero deleted tickets exist or the tile is just
                 * missing.
                 */}
                <Text size="11.5px" c="dark.2" style={{ alignSelf: 'center' }}>
                    Open, unclaimed and closed totals for the whole server — click one to
                    filter by it. Deleted tickets are archived; filter for them above.
                </Text>
            </Group>

            <Card p="md">
                <Group gap="md" align="flex-end" wrap="wrap">
                    <SegmentedControl
                        size="xs"
                        value={filter.status}
                        /*
                         * Through `applyStatus`, which also clears "unclaimed only" —
                         * setting status inline here preserved it, and "unclaimed +
                         * closed" is a combination that is almost always empty while the
                         * Unclaimed tile above still shows a non-zero count. That is
                         * exactly the strip-disagrees-with-the-rows confusion the counts
                         * strip was built to avoid.
                         */
                        onChange={(value) => applyStatus(value as TicketStatusFilter)}
                        data={[
                            { value: 'open', label: 'Open' },
                            { value: 'closed', label: 'Closed' },
                            { value: 'deleted', label: 'Deleted' },
                            { value: 'all', label: 'All' },
                        ]}
                    />
                    <Select
                        size="xs"
                        w={180}
                        aria-label="Ticket type"
                        data={typeFilterOptions(config)}
                        // Empty string is the "All types" option's value; the filter
                        // models no-type-filter as null, so the two are translated here
                        // rather than teaching either side about the other.
                        value={filter.type ?? ''}
                        onChange={(value) =>
                            setFilter((current) => ({ ...current, type: value || null }))
                        }
                        allowDeselect={false}
                    />
                    <Switch
                        size="sm"
                        label="Unclaimed only"
                        checked={filter.unclaimedOnly}
                        onChange={(event) =>
                            setFilter((current) => ({
                                ...current,
                                unclaimedOnly: event.currentTarget.checked,
                            }))
                        }
                    />
                    {/*
                     * Never `disabled` while a request is in flight. Fetch-on-keystroke
                     * plus `disabled` hands focus back to the body under HTML's focus
                     * fixup rule, and the operator's next character goes nowhere. The
                     * spinner in the right section says "working" without touching
                     * focus.
                     *
                     * The placeholder names exactly what the server matches: `searchByGuild`
                     * takes an exact `ticketNumber` when the query is a number, and
                     * otherwise a case-insensitive prefix of the identity snapshot columns.
                     * Deliberately *not* "title" — offering that would have operators typing
                     * a subject line and getting nothing back.
                     */}
                    <TextInput
                        size="xs"
                        flex="1 1 220px"
                        miw={220}
                        aria-label="Search tickets"
                        placeholder="Ticket number, or a person's name"
                        leftSection={<IconSearch size={14} />}
                        rightSection={searching ? <Loader size={12} color="brand" /> : null}
                        value={searchDraft}
                        onChange={(event) => setSearchDraft(event.currentTarget.value)}
                    />
                </Group>
            </Card>

            <Card p={0} style={{ overflow: 'hidden' }}>
                {/*
                 * Only the *first* read replaces the table with a spinner. A re-filter keeps
                 * the rows on screen and signals itself through the search field's inline
                 * loader, because blanking the whole table on every debounce tick reads as a
                 * page reload rather than a filter narrowing — and typing is exactly when it
                 * would have fired most.
                 */}
                {loading && tickets.length === 0 ? (
                    <Center py="xl">
                        <Loader color="brand" size="sm" />
                    </Center>
                ) : error ? (
                    <Alert
                        color="red"
                        icon={<IconAlertTriangle size={16} />}
                        title="Couldn't load tickets"
                        m="md"
                    >
                        {error}
                    </Alert>
                ) : tickets.length === 0 ? (
                    <Stack align="center" gap={6} py={48} px="md">
                        <IconTicket size={28} color="var(--mantine-color-dark-3)" />
                        <Text fw={700} size="15px">
                            {filtersActive ? 'Nothing matches that' : 'No tickets yet'}
                        </Text>
                        <Text c="dimmed" size="13px" ta="center" maw={440}>
                            {filtersActive
                                ? 'Your filters have narrowed this to nothing. The tickets may well exist — just not under these terms.'
                                : config?.configured
                                  ? 'Nobody has opened one. Either your members are unusually self-sufficient or nobody can find the button.'
                                  : 'Tickets are not set up in this server yet. Run /deploy-ticket-system in Discord, then the button exists for members to press.'}
                        </Text>
                        {filtersActive ? (
                            <Button mt="sm" variant="default" onClick={clearFilters}>
                                Clear filters
                            </Button>
                        ) : (
                            <Button
                                mt="sm"
                                component={Link}
                                to="/tickets/config"
                                variant="default"
                                leftSection={<IconSettings size={16} />}
                            >
                                Ticket settings
                            </Button>
                        )}
                    </Stack>
                ) : (
                    // `ScrollContainer` rather than letting the card's `overflow: hidden` do
                    // it: without this, a narrow viewport didn't just squeeze the table — it
                    // shrank every column, including ones with an explicit width, until the
                    // claim/close buttons were compressed off the edge with no way to reach
                    // them at all. Scrolling keeps every column at a readable width instead.
                    // Fits a 1280 laptop's content area, so only narrower screens scroll: at
                    // 1180 the actions column sat past the card's edge even at 1440.
                    <Table.ScrollContainer minWidth={900}>
                    {/*
                     * `layout="fixed"`: under the default `auto` layout, one very wide
                     * unbroken badge label (a guild can declare any type name it likes) made
                     * Chrome renegotiate every column's width around it, shrinking `Type`
                     * below its own `w` — fixed layout means each `Table.Th` width is taken
                     * as given, and an individual cell's own overflow rules handle the rest.
                     */}
                    <Table layout="fixed" verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th w={80}>Number</Table.Th>
                                <Table.Th w={150}>Type</Table.Th>
                                <Table.Th>Title</Table.Th>
                                <Table.Th w={140}>Subject</Table.Th>
                                <Table.Th w={140}>Claimed by</Table.Th>
                                <Table.Th w={120}>Last updated</Table.Th>
                                <Table.Th w={170} />
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {tickets.map((ticket) => {
                                const actions = availableActions(ticket);
                                return (
                                    <Table.Tr
                                        key={ticket.id}
                                        style={{ cursor: 'pointer' }}
                                        onClick={() => navigate(`/tickets/${ticket.id}`)}
                                    >
                                        <Table.Td>
                                            <Text ff="monospace" size="13px" fw={600}>
                                                {formatTicketNumber(ticket.ticketNumber)}
                                            </Text>
                                        </Table.Td>
                                        <Table.Td>
                                            {/*
                                             * A type the guild no longer declares still
                                             * has rows holding it, and they have to
                                             * render something. The raw key, in
                                             * monospace, so it is visibly not a label
                                             * somebody wrote.
                                             */}
                                            {ticket.typeLabel ? (
                                                // A guild names its own types, so a label can
                                                // easily outrun any column width chosen here —
                                                // the tooltip is what makes a truncated one
                                                // still readable rather than merely present.
                                                <Tooltip label={ticket.typeLabel} multiline w={250} withArrow>
                                                    <Badge variant="light" color="brand" radius="sm" style={{ maxWidth: '100%' }}>
                                                        {ticket.typeLabel}
                                                    </Badge>
                                                </Tooltip>
                                            ) : (
                                                <Tooltip
                                                    label="This server no longer declares that ticket type, so there is no label to show."
                                                    multiline
                                                    w={250}
                                                    withArrow
                                                >
                                                    <Text ff="monospace" size="12px" c="dark.2">
                                                        {ticket.type}
                                                    </Text>
                                                </Tooltip>
                                            )}
                                        </Table.Td>
                                        <Table.Td>
                                            <Text size="13.5px" fw={600} lineClamp={1}>
                                                {ticket.title}
                                            </Text>
                                            <Badge
                                                variant="light"
                                                color={TICKET_STATUS_TONE[ticket.status]}
                                                radius="sm"
                                                size="xs"
                                                mt={2}
                                            >
                                                {ticket.status}
                                            </Badge>
                                        </Table.Td>
                                        <Table.Td>
                                            {/*
                                             * A nickname plus a handle can run well past 180px
                                             * — `lineClamp` keeps the row short, the tooltip is
                                             * what keeps the rest of the name readable at all.
                                             */}
                                            <Tooltip label={participantLabel(ticket.subject)} multiline w={250} withArrow>
                                                <Text size="12.5px" c="dark.1" lineClamp={1}>
                                                    {participantLabel(ticket.subject)}
                                                </Text>
                                            </Tooltip>
                                        </Table.Td>
                                        <Table.Td>
                                            <Tooltip
                                                label={optionalParticipantLabel(ticket.claimer, 'Unclaimed')}
                                                multiline
                                                w={250}
                                                withArrow
                                                disabled={!ticket.claimer}
                                            >
                                                <Text size="12.5px" c="dark.2" lineClamp={1}>
                                                    {optionalParticipantLabel(
                                                        ticket.claimer,
                                                        'Unclaimed'
                                                    )}
                                                </Text>
                                            </Tooltip>
                                        </Table.Td>
                                        <Table.Td>
                                            <Text size="12.5px" c="dark.2">
                                                {formatUpdated(ticket.updatedAt)}
                                            </Text>
                                        </Table.Td>
                                        <Table.Td>
                                            <Group gap={6} justify="flex-end" wrap="nowrap">
                                                {actions.map((action) => {
                                                    const presentation =
                                                        TICKET_ACTION_PRESENTATION[action];
                                                    return (
                                                        <Button
                                                            key={action}
                                                            size="xs"
                                                            variant="subtle"
                                                            color={presentation.tone}
                                                            px={8}
                                                            loading={
                                                                acting?.ticketId === ticket.id &&
                                                                acting.action === action
                                                            }
                                                            disabled={
                                                                acting !== null &&
                                                                !(
                                                                    acting.ticketId ===
                                                                        ticket.id &&
                                                                    acting.action === action
                                                                )
                                                            }
                                                            // The row navigates; the
                                                            // buttons must not also.
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                act(ticket, action);
                                                            }}
                                                        >
                                                            {presentation.label}
                                                        </Button>
                                                    );
                                                })}
                                            </Group>
                                        </Table.Td>
                                    </Table.Tr>
                                );
                            })}
                        </Table.Tbody>
                    </Table>
                    </Table.ScrollContainer>
                )}

                {/*
                 * Said out loud, because a capped table that looks complete is a lie an
                 * operator acts on — "there are no other open tickets" is exactly the wrong
                 * conclusion to let them draw. The counts strip above still carries the
                 * guild's real totals, so the two together are honest about the gap.
                 */}
                {truncated && !loading && !error ? (
                    <Group
                        justify="center"
                        py="sm"
                        px="md"
                        style={{ borderTop: '1px solid var(--mantine-color-dark-4)' }}
                    >
                        <Text size="12.5px" c="dark.2" ta="center">
                            Showing the newest {tickets.length}. Narrow it with a filter or the
                            search box to see the rest.
                        </Text>
                    </Group>
                ) : null}
            </Card>
        </Stack>
    );
}

/** One number in the counts strip, clickable into the filter it describes. */
function CountTile({
    label,
    value,
    active,
    onClick,
}: {
    label: string;
    value: number;
    active: boolean;
    onClick: () => void;
}) {
    return (
        <UnstyledButton onClick={onClick}>
            <Card
                p="xs"
                px="md"
                bg={active ? 'dark.6' : 'dark.7'}
                style={{
                    borderColor: active ? 'var(--mantine-color-brand-6)' : undefined,
                }}
            >
                <Text size="11px" c="dark.2" fw={700} tt="uppercase">
                    {label}
                </Text>
                <Text size="20px" fw={800} lh={1.2}>
                    {value}
                </Text>
            </Card>
        </UnstyledButton>
    );
}
