import type { QueryClient, QueryKey } from '@tanstack/react-query';

/**
 * Put a save's answer into the cache as the newest thing known about that entry.
 *
 * A read of the entry can be in flight when the save answers — one already going when the
 * save started, or one a remount started while it flew (the operator went to another page
 * and came back) — and if the server read before the save wrote, that read carries the
 * value from before the save. Landing after this one, it would put the old value back on
 * screen as though the save had not happened. So any read still in flight is cancelled
 * first (left as it was before that read), then the answer is written.
 *
 * Called from the mutation's own `onSuccess`, so the save is still in flight while it runs.
 * The saves that use it carry the entry's query key as their `mutationKey` too, so a
 * remounted form sees the save in flight (`useSaveInFlight`) and cannot start a second one
 * over it.
 */
export async function writeSavedAnswer(queryClient: QueryClient, queryKey: QueryKey, answer: unknown): Promise<void> {
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData(queryKey, answer);
}
