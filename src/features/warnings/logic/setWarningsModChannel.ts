import type { Guild } from 'discord.js';
import { warningsConfigRepo, type WarningsConfigRepo } from '../data/warningsConfigRepo';
import type { WarningsConfig } from '../data/warningsConfigSchema';
import { validateWarningsModChannel } from './warningModChannel';

export type SetWarningsModChannelResult =
    | { ok: true; config: WarningsConfig }
    | { ok: false; message: string };

interface SetWarningsModChannelDeps {
    repo?: WarningsConfigRepo;
}

/**
 * Single validate-and-persist path for the warnings mod channel, shared by the
 * Discord slash-modal handler and the web config PUT route. Runs
 * {@link validateWarningsModChannel} against the guild, and on success upserts the channel.
 *
 * Takes the guild its caller already holds — the interaction's, or the one the route's
 * guild access check resolved — rather than looking it up again through the process's
 * Discord client.
 *
 * Returns a discriminated result — the caller supplies its own presentation glue
 * (Discord reply vs. HTTP response). The `message` is user-safe on failure.
 */
export async function setWarningsModChannel(
    guild: Guild,
    channelId: string,
    deps: SetWarningsModChannelDeps = {}
): Promise<SetWarningsModChannelResult> {
    const repo = deps.repo ?? warningsConfigRepo;

    const validation = await validateWarningsModChannel(guild, channelId);
    if (!validation.ok) {
        return { ok: false, message: validation.userMessage };
    }

    try {
        const config = await repo.upsertModChannel(guild.id, validation.channelId);
        return { ok: true, config };
    } catch (error) {
        console.error('[warnings] Error saving warnings configuration:', error);
        return { ok: false, message: 'Could not save that warnings config. Try again in a second.' };
    }
}
