/**
 * One ticket, in full.
 *
 * **The record is all there is.** A ticket stores no messages — `TicketDetail` has no
 * `messages` member and the database has no table for one — because the conversation
 * happens in a Discord channel and stays there. So this page shows the record and links
 * to the channel, and says which is which. An empty "messages" panel would be a lie that
 * looked like a loading bug.
 *
 * Lifecycle actions come from the same `availableActions` the list rows use, for the same
 * reason: one rule, in one place, that a test can reach.
 */

import {
    Alert,
    Anchor,
    Badge,
    Button,
    Card,
    Center,
    Group,
    Loader,
    Stack,
    Text,
    Title,
} from '@mantine/core';
import {
    IconAlertTriangle,
    IconBrandDiscord,
    IconChevronLeft,
    IconTicket,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ApiError, getTicketOptions, type TicketDetail } from '@brattybot/web-sdk';
import { loadErrorMessage } from '../api/loadErrorMessage';
import { availableActions, TICKET_ACTION_PRESENTATION } from '../tickets/ticketActions';
import { useTicketAction } from '../tickets/useTicketAction';
import { formatTicketNumber, TICKET_STATUS_TONE } from '../tickets/ticketPresentation';
import { optionalParticipantLabel, participantLabel } from '../tickets/participantLabel';
import { useGuilds } from '../guilds/GuildContext';
import { PAGE_MAX_WIDTH } from '../theme';

function formatMoment(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
}

/** One row of the timeline. Null timestamps are dropped by the caller, not rendered as a dash. */
interface TimelineEntry {
    readonly label: string;
    readonly at: string;
}

function timelineOf(ticket: TicketDetail): TimelineEntry[] {
    const candidates: { label: string; at: string | null }[] = [
        { label: 'Opened', at: ticket.openedAt },
        { label: 'Claimed', at: ticket.claimedAt },
        { label: 'Closed', at: ticket.closedAt },
        { label: 'Deleted', at: ticket.deletedAt },
    ];
    // Filtered rather than rendered with placeholders: "Closed —" on an open ticket reads
    // as missing data, when in fact the event simply has not happened.
    return candidates.flatMap((entry) => (entry.at ? [{ label: entry.label, at: entry.at }] : []));
}

export function TicketDetailPage() {
    const { selected, loading: guildsLoading } = useGuilds();
    const { ticketId: rawTicketId } = useParams<{ ticketId: string }>();

    const guildId = selected?.id;
    // Parsed once, here, so a junk path segment never reaches the API as `/tickets/NaN`.
    const parsedId = Number(rawTicketId);
    const ticketId = Number.isSafeInteger(parsedId) && parsedId > 0 ? parsedId : null;

    /*
     * The ticket, keyed by guild and id, so a slow read of one ticket can never overwrite
     * the page after it has moved to another.
     */
    const ticketQuery = useQuery({
        ...getTicketOptions({ path: { guildId: guildId ?? '', ticketId: String(ticketId ?? '') } }),
        enabled: !!guildId && ticketId !== null,
    });
    const ticket = ticketQuery.data ?? null;
    const loading = ticketQuery.isPending;
    /*
     * A 404 is not the same failure as a broken request, and it is rendered as an answer
     * ("that ticket is not here") rather than a red alert implying something went wrong
     * with the server. Either one replaces the ticket — a re-read after an action that
     * fails included — so the page never shows a record it could not confirm.
     */
    const missing = ticketQuery.error instanceof ApiError && ticketQuery.error.status === 404;
    const error = missing ? null : loadErrorMessage(ticketQuery.error, 'Failed to load that ticket');

    /*
     * Which action is in flight, on which ticket — not merely whether one is, matching the
     * list page. A shared flag put every button on the card into `loading` at once, so
     * clicking Claim spun Close as well; and a page that has since moved to another ticket
     * must not spin that ticket's buttons.
     */
    const { acting: actingOnAny, act } = useTicketAction(guildId);
    const acting = actingOnAny?.ticketId === ticketId ? actingOnAny : null;

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

    const breadcrumb = (
        <div>
            <Text size="12.5px" c="dark.2">
                <Text span c="dark.1" fw={600}>
                    {selected.name}
                </Text>{' '}
                › Configure ›{' '}
                <Anchor component={Link} to="/tickets" size="12.5px" c="dark.2" underline="hover">
                    Tickets
                </Anchor>{' '}
                › {ticket ? formatTicketNumber(ticket.ticketNumber) : 'Ticket'}
            </Text>
        </div>
    );

    if (ticketId === null) {
        return (
            <Stack gap="lg" maw={PAGE_MAX_WIDTH}>
                {breadcrumb}
                <Alert color="gray" icon={<IconAlertTriangle size={16} />} title="Not a ticket id">
                    <Stack gap="sm" align="flex-start">
                        <Text size="13.5px">
                            <Text span ff="monospace">
                                {rawTicketId}
                            </Text>{' '}
                            isn&apos;t a ticket id. Something mangled the link on the way here.
                        </Text>
                        <BackToList />
                    </Stack>
                </Alert>
            </Stack>
        );
    }

    return (
        <Stack gap="lg" maw={PAGE_MAX_WIDTH}>
            {breadcrumb}

            {loading ? (
                <Center py="xl">
                    <Loader color="brand" size="sm" />
                </Center>
            ) : missing ? (
                <Alert color="gray" icon={<IconTicket size={16} />} title="No such ticket">
                    <Stack gap="sm" align="flex-start">
                        <Text size="13.5px">
                            Ticket {ticketId} isn&apos;t in this server. Either it never existed, or
                            it belongs to somewhere you don&apos;t have the keys to.
                        </Text>
                        <BackToList />
                    </Stack>
                </Alert>
            ) : error ? (
                <Alert
                    color="red"
                    icon={<IconAlertTriangle size={16} />}
                    title="Couldn't load that ticket"
                >
                    <Stack gap="sm" align="flex-start">
                        <Text size="13.5px">{error}</Text>
                        <BackToList />
                    </Stack>
                </Alert>
            ) : ticket ? (
                <>
                    <Group justify="space-between" align="flex-end" wrap="wrap">
                        <div>
                            <Group gap={10}>
                                <IconTicket size={22} color="var(--mantine-color-brand-6)" />
                                <Title order={1} size="24px">
                                    {ticket.title}
                                </Title>
                            </Group>
                            <Group gap={8} mt={6}>
                                <Text ff="monospace" size="13px" c="dark.2">
                                    {formatTicketNumber(ticket.ticketNumber)}
                                </Text>
                                <Badge
                                    variant="light"
                                    color={TICKET_STATUS_TONE[ticket.status]}
                                    radius="sm"
                                    size="sm"
                                >
                                    {ticket.status}
                                </Badge>
                                {ticket.typeLabel ? (
                                    <Badge variant="light" color="brand" radius="sm" size="sm">
                                        {ticket.typeLabel}
                                    </Badge>
                                ) : (
                                    <Text ff="monospace" size="12px" c="dark.2">
                                        {ticket.type} (type no longer declared)
                                    </Text>
                                )}
                            </Group>
                        </div>
                        <Group gap={8}>
                            {availableActions(ticket).map((action) => {
                                const presentation = TICKET_ACTION_PRESENTATION[action];
                                return (
                                    <Button
                                        key={action}
                                        color={presentation.tone}
                                        variant={presentation.tone === 'gray' ? 'default' : 'filled'}
                                        loading={acting?.action === action}
                                        // Every button is held while any one is in
                                        // flight, so a second transition cannot be
                                        // started against a row mid-change.
                                        disabled={acting !== null && acting.action !== action}
                                        onClick={() => act(ticket, action)}
                                    >
                                        {presentation.label}
                                    </Button>
                                );
                            })}
                        </Group>
                    </Group>

                    <Card p="lg">
                        <Text fw={700} size="15px" mb={6}>
                            Why it was opened
                        </Text>
                        {/*
                         * In full, never truncated. The reason is the only thing on this
                         * page that says what the ticket is actually about, and an
                         * ellipsis in the middle of it would force a trip to Discord to
                         * read a field the database already holds. `pre-wrap` keeps the
                         * line breaks the member typed.
                         */}
                        <Text size="13.5px" c="dark.1" style={{ whiteSpace: 'pre-wrap' }}>
                            {ticket.reason.trim() || 'Nothing written. Bold of them.'}
                        </Text>
                    </Card>

                    <Group align="stretch" gap="md" wrap="wrap">
                        <Card p="lg" flex="1 1 300px">
                            <Text fw={700} size="15px" mb="sm">
                                Who is involved
                            </Text>
                            <Stack gap="sm">
                                <PersonRow label="Subject" value={participantLabel(ticket.subject)} />
                                {/*
                                 * "Automated" rather than a dash: a flow-opened ticket has
                                 * no opener because nothing human opened it, and that is a
                                 * fact worth stating.
                                 */}
                                <PersonRow
                                    label="Opened by"
                                    value={optionalParticipantLabel(
                                        ticket.opener,
                                        'Automated — a flow opened this, not a person'
                                    )}
                                />
                                <PersonRow
                                    label="Claimed by"
                                    value={optionalParticipantLabel(
                                        ticket.claimer,
                                        'Unclaimed — nobody has picked this up'
                                    )}
                                />
                            </Stack>
                        </Card>

                        <Card p="lg" flex="1 1 300px">
                            <Text fw={700} size="15px" mb="sm">
                                Timeline
                            </Text>
                            <Stack gap="sm">
                                {timelineOf(ticket).map((entry) => (
                                    <Group key={entry.label} justify="space-between" gap="md">
                                        <Text size="12.5px" c="dark.2" fw={600}>
                                            {entry.label}
                                        </Text>
                                        <Text size="12.5px" c="dark.1">
                                            {formatMoment(entry.at)}
                                        </Text>
                                    </Group>
                                ))}
                            </Stack>
                        </Card>
                    </Group>

                    <Card p="lg">
                        <Text fw={700} size="15px" mb={6}>
                            The conversation isn&apos;t here
                        </Text>
                        <Text size="13px" c="dimmed" mb={ticket.channelId ? 'md' : 0} maw={620}>
                            Tickets store no messages — none of this was ever written to the
                            database. Everything anybody said lives in the Discord channel, which is
                            also the only place to say anything back.
                        </Text>
                        {ticket.channelId ? (
                            <Button
                                component="a"
                                href={`https://discord.com/channels/${selected.id}/${ticket.channelId}`}
                                target="_blank"
                                rel="noreferrer"
                                color="brand"
                                leftSection={<IconBrandDiscord size={16} />}
                            >
                                Open the channel in Discord
                            </Button>
                        ) : (
                            <Text size="13px" c="dark.2" mt="xs" maw={620}>
                                The channel is gone — deleted in Discord, by this bot or by hand.
                                This record outlived it, so the who and the when survive; the
                                transcript did not.
                            </Text>
                        )}
                    </Card>
                </>
            ) : null}
        </Stack>
    );
}

function PersonRow({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <Text size="11px" c="dark.2" fw={700} tt="uppercase">
                {label}
            </Text>
            <Text size="13.5px" c="dark.1">
                {value}
            </Text>
        </div>
    );
}

function BackToList() {
    return (
        <Button
            component={Link}
            to="/tickets"
            variant="default"
            size="xs"
            leftSection={<IconChevronLeft size={14} />}
        >
            Back to tickets
        </Button>
    );
}
