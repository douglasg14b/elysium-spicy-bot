import { useQueries, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getMemberNamesOptions, getMemberNamesQueryKey, type MemberName, type MemberNameList } from '@brattybot/web-sdk';
import { memberNameRequests, type MemberNames } from './memberNames';

type MemberNamesQueryKey = ReturnType<typeof getMemberNamesQueryKey>;

/** What this guild's names requests have settled so far in this tab. */
interface NamesSoFar {
    /** Every name answered, by id. */
    readonly names: Map<string, MemberName>;
    /** Every id an answered request asked about, named in it or not. */
    readonly asked: Set<string>;
}

function namesSoFar(queryClient: QueryClient, guildId: string): NamesSoFar {
    // The key every names request for this guild starts with: the generated key minus its ids.
    const { query: _ids, ...guildKey } = getMemberNamesQueryKey({ path: { guildId }, query: { ids: '' } })[0];
    const names = new Map<string, MemberName>();
    const asked = new Set<string>();
    for (const query of queryClient.getQueryCache().findAll({ queryKey: [guildKey] })) {
        if (query.state.status !== 'success') continue;
        // Found by this guild's names key above, so it is one, built by `getMemberNamesOptions`.
        const [key] = query.queryKey as MemberNamesQueryKey;
        for (const userId of key.query.ids.split(',')) asked.add(userId);
        for (const member of (query.state.data as MemberNameList).members) names.set(member.userId, member);
    }
    return { names, asked };
}

/**
 * Who each id a view shows is (`getMemberNames`).
 *
 * **Each id is asked about once a tab**, and the answer kept: the route counts against the
 * signed-in person's Discord budget (it may look people up), and a page whose rows change
 * with every filter and search would otherwise spend it on people it has asked about — and
 * refuse their next warning write with a 429. So a filter showing only people already asked
 * about sends nothing, and nobody already named flickers back to their snapshot while a new
 * request is out. An id the answer left out (an account Discord does not know, or a lookup
 * over the cap) and a name changed mid-session fill in on the next page load. A failed
 * request is asked again the next time a view shows its ids.
 *
 * One request for the ids, or one per hundred. Names missing — still loading, or a failed
 * request — leave the view on what it already had (a row's snapshot, else the id), so a
 * name it cannot fill in is never an error on the page.
 */
export function useMemberNames(guildId: string, userIds: Iterable<string>): MemberNames {
    const queryClient = useQueryClient();
    // Read on every render: an answer landing re-renders this view through `useQueries`.
    const { names, asked } = namesSoFar(queryClient, guildId);
    const unasked = [...userIds].filter((userId) => !asked.has(userId));

    useQueries({
        queries: memberNameRequests(unasked).map((ids) => ({
            ...getMemberNamesOptions({ path: { guildId }, query: { ids } }),
            staleTime: Infinity,
            gcTime: Infinity,
        })),
    });

    return names;
}
