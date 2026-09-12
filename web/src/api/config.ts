/** Feature-config API helpers, keeping page components free of URL wrangling. */

import { api } from './client';
import type { GuildChannel, WarningsConfig } from './types';

export function getGuildChannels(guildId: string): Promise<GuildChannel[]> {
    return api
        .get<{ channels: GuildChannel[] }>(`/api/guilds/${guildId}/channels`)
        .then((res) => res.channels);
}

export function getWarningsConfig(guildId: string): Promise<WarningsConfig> {
    return api.get<WarningsConfig>(`/api/guilds/${guildId}/config/warnings`);
}

export function updateWarningsConfig(
    guildId: string,
    modChannelId: string
): Promise<WarningsConfig> {
    return api.put<WarningsConfig>(`/api/guilds/${guildId}/config/warnings`, { modChannelId });
}
