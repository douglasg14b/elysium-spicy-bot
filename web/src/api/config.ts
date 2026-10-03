/** Feature-config API helpers, keeping page components free of URL wrangling. */

import { api } from './client';
import type { GuildChannel } from './types';

/**
 * The guild's channel directory. Stays on the hand-written client until its remaining
 * callers (the flow builder, the resources dialog, the tickets config) move to the
 * generated SDK's `getGuildChannelsOptions`, as the warnings page has.
 */
export function getGuildChannels(guildId: string): Promise<GuildChannel[]> {
    return api
        .get<{ channels: GuildChannel[] }>(`/api/guilds/${guildId}/channels`)
        .then((res) => res.channels);
}
