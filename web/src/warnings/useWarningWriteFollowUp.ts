import { useCallback } from 'react';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, listWarningsQueryKey, type WarningResult } from '@brattybot/web-sdk';
import { noticeProblem, warningWriteDone, type WarningWrite } from './warningPresentation';

/** What a warning dialog does once its write has been answered, either way. */
export interface WarningWriteFollowUp {
    /**
     * After a write landed: say so naming the slug, say plainly when its mod-log notice did
     * not go out, then re-read the list and wait for it.
     */
    readonly landed: (guildId: string, write: WarningWrite, result: WarningResult) => Promise<void>;
    /**
     * After a write was refused because the warning moved under the dialog — released,
     * edited by somebody else, or gone: say the server's sentence and re-read the list, so
     * the drawer shows the warning as it now is.
     */
    readonly moved: (guildId: string, error: ApiError) => Promise<void>;
}

/**
 * What every warning write does once the server has answered, shared by the issue, edit and
 * release dialogs so the three cannot drift (the `useTicketAction` pattern).
 *
 * **The list is re-read, never patched from the answer**: the counts are server-wide and a
 * changed warning may no longer match the filter. Cached filters nobody is showing are
 * dropped rather than kept, so moving to another one reads afresh instead of showing a
 * warning as it was. The returned promise settles once the table has caught up; the dialogs
 * hold their `busy` state across it, so their button spins until then.
 *
 * **A notice that did not go out stays on screen until dismissed.** The warning is saved —
 * not an error — but the mod log is missing an entry, and somebody has to know to look.
 */
export function useWarningWriteFollowUp(): WarningWriteFollowUp {
    const queryClient = useQueryClient();

    const reread = useCallback(
        async (guildId: string): Promise<void> => {
            const queryKey = listWarningsQueryKey({ path: { guildId } });
            queryClient.removeQueries({ queryKey, type: 'inactive' });
            await queryClient.invalidateQueries({ queryKey });
        },
        [queryClient]
    );

    const landed = useCallback(
        async (guildId: string, write: WarningWrite, result: WarningResult): Promise<void> => {
            notifications.show({ color: 'brand', title: 'Done', message: warningWriteDone(write, result.slug) });
            const problem = noticeProblem(result.notice);
            if (problem) {
                notifications.show({ color: 'red', title: problem.title, message: problem.message, autoClose: false });
            }
            await reread(guildId);
        },
        [reread]
    );

    const moved = useCallback(
        async (guildId: string, error: ApiError): Promise<void> => {
            notifications.show({ color: 'red', title: 'It moved under you', message: error.message });
            await reread(guildId);
        },
        [reread]
    );

    return { landed, moved };
}
