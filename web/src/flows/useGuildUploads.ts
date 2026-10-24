/**
 * A server's uploaded pictures for the flow builder's controls: the list, and the upload.
 *
 * The page's, not a control's — no control fetches. Read through the query cache, so every
 * picture popover in the builder shows the same list. Uploads go through `keepGuildUpload`, the
 * Uploads page's own path, so a picture added or deleted on either is what the other shows next.
 */

import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listGuildUploadsOptions, type GuildUpload } from '@brattybot/web-sdk';
import { uploadImageUrl } from '../api/uploadImageUrl';
import { keepGuildUpload } from '../uploads/keepGuildUpload';
import type { GuildUploads } from './controls/types';

const NO_ITEMS: readonly GuildUpload[] = [];

/**
 * `guildId`'s uploads, read once the guild is known. Without a guild there is nothing to list,
 * and an upload is refused before anything is sent.
 */
export function useGuildUploads(guildId: string | undefined): GuildUploads {
    const queryClient = useQueryClient();
    const path = { guildId: guildId ?? '' };
    const listed = useQuery({ ...listGuildUploadsOptions({ path }), enabled: !!guildId });
    const items = listed.data?.uploads ?? NO_ITEMS;

    return useMemo<GuildUploads>(
        () => ({
            items,
            upload: async (file) => {
                if (!guildId) {
                    throw new Error('No server is picked, so there is nowhere to keep that picture.');
                }
                return (await keepGuildUpload(queryClient, guildId, file)).upload;
            },
            // No guild means the builder has nothing open, so no picture is on screen to show.
            imageUrl: (uploadId) => (guildId ? uploadImageUrl({ guildId, uploadId }) : ''),
        }),
        [guildId, items, queryClient]
    );
}
