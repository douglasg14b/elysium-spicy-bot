import type { Guild } from 'discord.js';
import { ChannelType } from 'discord.js';
import { DISCORD_CLIENT } from '../../../discordClient';
import {
    flowButtonMessagesRepo,
    type FlowButtonMessagesRepo,
} from '../data/flowButtonMessagesRepo';
import type { FlowButtonMessageEntity } from '../data/flowButtonMessagesSchema';

/**
 * What became of one recorded button message.
 *
 * `removed` and `alreadyGone` are both successes and are kept apart only so the report
 * can be honest about what it actually did. The desired state — no live button — holds
 * either way.
 */
const UNDEPLOY_OUTCOMES = ['removed', 'alreadyGone', 'failed'] as const;
export type UndeployOutcome = (typeof UNDEPLOY_OUTCOMES)[number];

export interface UndeployedButtonMessage {
    readonly channelId: string;
    readonly messageId: string;
    readonly outcome: UndeployOutcome;
    /** Set for `failed`. */
    readonly explanation?: string;
}

export interface UndeployFlowButtonsResult {
    readonly results: readonly UndeployedButtonMessage[];
}

interface UndeployFlowButtonsDeps {
    getGuild?: (guildId: string) => Promise<Guild | null>;
    buttonMessagesRepo?: Pick<FlowButtonMessagesRepo, 'listByFlowId' | 'forget'>;
}

async function defaultGetGuild(guildId: string): Promise<Guild | null> {
    return (
        DISCORD_CLIENT.guilds.cache.get(guildId) ??
        (await DISCORD_CLIENT.guilds.fetch(guildId).catch(() => null))
    );
}

/**
 * Take a flow's trigger buttons back out of the guild.
 *
 * Deletes each recorded message, then drops its row — the same ordering, for the same
 * reason, as `applyUnpublishPlan`: a crash in between leaves a row naming a message
 * that is already gone, which the next run handles as `alreadyGone`. The reverse order
 * would leave a live button with nothing that knows where it is.
 *
 * **A message somebody already deleted by hand is a success, not an error.** The goal
 * is "no live button", and it holds. Treating it as a failure would make the ordinary
 * case of tidying up by hand look like a fault.
 *
 * Per-message failures do not abort the run. Buttons in one channel have nothing to do
 * with buttons in another, and stopping at the first would strand the rest.
 */
export async function undeployFlowButtons(
    guildId: string,
    flowId: string,
    deps: UndeployFlowButtonsDeps = {}
): Promise<UndeployFlowButtonsResult> {
    const repo = deps.buttonMessagesRepo ?? flowButtonMessagesRepo;
    const recorded = await repo.listByFlowId(guildId, flowId);
    if (recorded.length === 0) {
        return { results: [] };
    }

    const guild = await (deps.getGuild ?? defaultGetGuild)(guildId);
    if (!guild) {
        // Without the guild nothing can be deleted, and dropping the rows anyway would
        // discard the only record of where those live buttons are.
        return {
            results: recorded.map((row) => ({
                channelId: row.channelId,
                messageId: row.messageId,
                outcome: 'failed' as const,
                explanation: 'That server is unavailable right now, so its buttons were left alone. Try again in a moment.',
            })),
        };
    }

    const results: UndeployedButtonMessage[] = [];
    for (const row of recorded) {
        results.push(await retireOne(guild, repo, row));
    }

    return { results };
}

async function retireOne(
    guild: Guild,
    repo: Pick<FlowButtonMessagesRepo, 'forget'>,
    row: FlowButtonMessageEntity
): Promise<UndeployedButtonMessage> {
    const base = { channelId: row.channelId, messageId: row.messageId } as const;

    const deletion = await deleteMessage(guild, row);
    if (deletion.outcome === 'failed') {
        // The message is still live, so its record must stay — it is the only way to
        // find those buttons on a later attempt.
        return { ...base, outcome: 'failed', explanation: deletion.explanation };
    }

    try {
        await repo.forget(row.id);
    } catch (error) {
        return {
            ...base,
            outcome: 'failed',
            explanation: `The buttons were removed, but their record could not be deleted: ${describeError(error)}. Run this again to clear it.`,
        };
    }

    return { ...base, outcome: deletion.outcome };
}

/**
 * Delete one recorded message, distinguishing "gone now" from "was already gone".
 *
 * A missing channel, a missing message and Discord's 10008 `Unknown Message` all mean
 * the same thing: there is no live button there. Each is reported as `alreadyGone`
 * rather than as an error, and each still leads to the row being dropped.
 */
async function deleteMessage(
    guild: Guild,
    row: FlowButtonMessageEntity
): Promise<{ outcome: 'removed' | 'alreadyGone' } | { outcome: 'failed'; explanation: string }> {
    const channel = guild.channels.cache.get(row.channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
        return { outcome: 'alreadyGone' };
    }

    try {
        const message = await channel.messages.fetch(row.messageId);
        await message.delete();
        return { outcome: 'removed' };
    } catch (error) {
        if (isUnknownMessage(error)) {
            return { outcome: 'alreadyGone' };
        }
        return {
            outcome: 'failed',
            explanation: `Could not delete the button message in <#${row.channelId}>: ${describeError(error)}`,
        };
    }
}

/**
 * Discord's "this message does not exist", by code rather than by message text.
 *
 * 10008 is `Unknown Message`. Matching on the numeric code rather than on the string
 * keeps this working when the wording changes, and keeps a genuine permission error
 * from being mistaken for a tidy-up.
 */
function isUnknownMessage(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code: unknown }).code === 10008
    );
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
