import { useCallback, useSyncExternalStore } from 'react';
import { useQueryClient, type MutationKey } from '@tanstack/react-query';

/**
 * Whether any save carrying `mutationKey` is in flight — this mount's, or one an earlier
 * mount of the same form left running when the operator went elsewhere and came back.
 *
 * Read live rather than through `useIsMutating`. That hook computes its answer once as the
 * component first renders and only recomputes on a mutation-cache event after its
 * subscription is set up, so a save that settles between a remount's first render and that
 * subscription leaves it reporting "saving" until the next event — the settled save's
 * garbage collection, five minutes on. Here React re-reads the count once subscribed, and
 * a count is a plain value, so nothing goes stale.
 */
export function useSaveInFlight(mutationKey: MutationKey): boolean {
    const mutationCache = useQueryClient().getMutationCache();
    const subscribe = useCallback((onChange: () => void) => mutationCache.subscribe(onChange), [mutationCache]);
    return useSyncExternalStore(subscribe, () => mutationCache.findAll({ mutationKey, status: 'pending' }).length > 0);
}
