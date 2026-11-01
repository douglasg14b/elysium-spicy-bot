import { useMemo, useState } from 'react';
import { Avatar, Group, Loader, Select, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { searchGuildMembersOptions, type GuildMemberMatch } from '@brattybot/web-sdk';
import { loadErrorMessage } from '../api/loadErrorMessage';
import { memberSearchTerm, MEMBER_SEARCH_MIN_LENGTH } from './memberSearch';

/** How long typing waits before it becomes a search. Searches share the bot's Discord budget with every write. */
const MEMBER_SEARCH_DEBOUNCE_MS = 350;

const NO_MATCHES: readonly GuildMemberMatch[] = [];

interface MemberPickerProps {
    readonly guildId: string;
    /** The picked member's user id, or null. */
    readonly value: string | null;
    readonly onChange: (memberId: string | null) => void;
    /** A refusal to show under the field — the form's, which wins over the search's own. */
    readonly error?: string;
}

/**
 * Pick a member by name: Discord's own name-prefix search (`searchGuildMembers`), asked once
 * two characters are typed and the typing has paused, so a name costs one request rather than
 * one per keystroke out of the 30-a-minute Discord budget.
 *
 * **Bound by id.** Each option's value is the user id and its label only what the box shows,
 * so two members sharing a nickname stay two members. The picked member is kept in the options
 * after the search moves on, or the box would lose the name it is showing.
 *
 * A refused search (a 429 when the budget runs out) shows its sentence under the field and
 * leaves the rest of the form alone.
 */
export function MemberPicker({ guildId, value, onChange, error }: MemberPickerProps) {
    const [search, setSearch] = useState('');
    const [picked, setPicked] = useState<GuildMemberMatch | null>(null);
    const [debounced] = useDebouncedValue(search, MEMBER_SEARCH_DEBOUNCE_MS);

    const term = memberSearchTerm(debounced, picked);
    const query = useQuery({
        ...searchGuildMembersOptions({ path: { guildId }, query: { q: term ?? '' } }),
        enabled: term !== null,
        placeholderData: keepPreviousData,
    });
    const found = term === null ? NO_MATCHES : (query.data ?? NO_MATCHES);

    const members = useMemo(() => {
        const byId = new Map<string, GuildMemberMatch>(found.map((member) => [member.id, member]));
        if (picked && !byId.has(picked.id)) byId.set(picked.id, picked);
        return byId;
    }, [found, picked]);
    const options = useMemo(
        () => [...members.values()].map((member) => ({ value: member.id, label: member.displayName })),
        [members]
    );

    const typing = search.trim() !== debounced.trim() || (term !== null && query.isFetching);
    const searchError = loadErrorMessage(query.error, "Couldn't search the member list. Try again in a second.");

    return (
        <Select
            label="Member"
            // The box shows a picked member's display name only; their handle is what tells two
            // members sharing a nickname apart, so it is said once one is picked.
            description={
                value && picked?.id === value
                    ? `That's @${picked.username}.`
                    : "Who's in trouble. Start typing their name or username."
            }
            placeholder="Two letters of their name"
            searchable
            clearable
            data={options}
            value={value}
            searchValue={search}
            onSearchChange={setSearch}
            onChange={(memberId) => {
                setPicked(memberId ? (members.get(memberId) ?? null) : null);
                onChange(memberId);
            }}
            // The server already matched on the start of a username or nickname; Mantine's own
            // filter would hide a username match whose display name reads differently.
            filter={({ options: all }) => all}
            nothingFoundMessage={
                search.trim().length < MEMBER_SEARCH_MIN_LENGTH
                    ? 'Type at least two letters of their name.'
                    : typing
                      ? 'Looking…'
                      : "Nobody by that name. Bots don't count."
            }
            rightSection={typing ? <Loader size={12} color="brand" /> : undefined}
            error={error ?? searchError ?? undefined}
            renderOption={({ option }) => {
                const member = members.get(option.value);
                if (!member) return option.label;
                return (
                    <Group gap="sm" wrap="nowrap">
                        <Avatar src={member.avatarUrl ?? undefined} radius="xl" size={26} color="brand">
                            {member.displayName.slice(0, 2).toUpperCase()}
                        </Avatar>
                        <div style={{ overflow: 'hidden' }}>
                            <Text size="13px" fw={600} lineClamp={1}>
                                {member.displayName}
                            </Text>
                            <Text size="11.5px" c="dimmed" lineClamp={1}>
                                @{member.username}
                            </Text>
                        </div>
                    </Group>
                );
            }}
        />
    );
}
