import type { Guild } from 'discord.js';
import { DISCORD_CLIENT } from '../../../discordClient';
import { warningsConfigRepo, type WarningsConfigRepo } from '../data/warningsConfigRepo';
import type { WarningsConfig } from '../data/warningsConfigSchema';
import { validateWarningsModChannel } from './warningModChannel';

export type SetWarningsModChannelResult =
    | { ok: true; config: WarningsConfig }
    | { ok: false; message: string };

interface SetWarningsModChannelDeps {
    /** Resolves the guild for validation. Defaults to the live Discord client cache/fetch. */
    getGuild?: (guildId: string) => Promise<Guild | null>;
    repo?: WarningsConfigRepo;
}

async function defaultGetGuild(guildId: string): Promise<Guild | null> {
    return (
        DISCORD_CLIENT.guilds.cache.get(guildId) ??
        (await DISCORD_CLIENT.guilds.fetch(guildId).catch(() => null))
    );
}

/**
 * Single validate-and-persist path for the warnings mod channel, shared by the
 * Discord slash-modal handler and the web config PUT route. Fetches the guild,
 * runs {@link validateWarningsModChannel}, and on success upserts the channel.
 *
 * Returns a discriminated result — the caller supplies its own presentation glue
 * (Discord reply vs. HTTP response). The `message` is user-safe on failure.
 */
export async function setWarningsModChannel(
    guildId: string,
    channelId: string,
    deps: SetWarningsModChannelDeps = {}
): Promise<SetWarningsModChannelResult> {
    const getGuild = deps.getGuild ?? defaultGetGuild;
    const repo = deps.repo ?? warningsConfigRepo;

    const guild = await getGuild(guildId);
    if (!guild) {
        return { ok: false, message: 'That server is unavailable right now. Try again in a moment.' };
    }

    const validation = await validateWarningsModChannel(guild, channelId);
    if (!validation.ok) {
        return { ok: false, message: validation.userMessage };
    }

    try {
        const config = await repo.upsertModChannel(guildId, validation.channelId);
        return { ok: true, config };
    } catch (error) {
        console.error('[warnings] Error saving warnings configuration:', error);
        return { ok: false, message: 'Could not save that warnings config. Try again in a second.' };
    }
}
