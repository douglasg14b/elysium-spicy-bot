import {
    ActionRowBuilder,
    ButtonBuilder,
    ChannelType,
    type Guild,
    type TextChannel,
} from 'discord.js';
import { DISCORD_CLIENT } from '../../../discordClient';
import {
    flowButtonMessagesRepo,
    type FlowButtonMessagesRepo,
} from '../data/flowButtonMessagesRepo';
import { flowsRepo, type FlowsRepo } from '../data/flowsRepo';
import type { FlowEntity } from '../data/flowsSchema';
import { planButtonDeployment, type ButtonDestination } from './planButtonDeployment';
import { undeployFlowButtons, type UndeployFlowButtonsResult } from './undeployFlowButtons';

/**
 * Where one message landed, so the caller can report per channel rather than per flow.
 *
 * An id rather than a live `TextChannel`: both callers only need to name the channel,
 * and `<#id>` renders a mention without dragging a discord.js object through a domain
 * result that the web route would then have to map back down to an id anyway.
 */
export interface DeployedButtonMessage {
    readonly channelId: string;
    readonly messageId: string;
    readonly buttonCount: number;
}

export type DeployFlowButtonsResult =
    | {
          ok: true;
          flow: FlowEntity;
          posted: readonly DeployedButtonMessage[];
          buttonCount: number;
      }
    | { ok: false; message: string };

interface DeployFlowButtonsDeps {
    /** Resolves the guild. Defaults to the live Discord client cache/fetch. */
    getGuild?: (guildId: string) => Promise<Guild | null>;
    repo?: FlowsRepo;
    /** Where the posted messages are written down. Overridable for tests. */
    buttonMessagesRepo?: Pick<FlowButtonMessagesRepo, 'persist'>;
    /** Retires whatever this flow already has live. Overridable for tests. */
    undeploy?: (guildId: string, flowId: string) => Promise<UndeployFlowButtonsResult>;
}

async function defaultGetGuild(guildId: string): Promise<Guild | null> {
    return (
        DISCORD_CLIENT.guilds.cache.get(guildId) ??
        (await DISCORD_CLIENT.guilds.fetch(guildId).catch(() => null))
    );
}

/**
 * Single load-validate-and-post path for deploying a flow's trigger buttons,
 * shared by the `/flow-deploy` slash command and the web deploy route. Mirrors
 * {@link setWarningsModChannel} — a discriminated result, no presentation glue.
 *
 * Each `trigger.buttonClick` node names its own channel, so this posts **one message
 * per destination**: a journey on one canvas can open "Agree to Rules" in `#rules` and
 * "Start Verification" in `#verify-me` without being split into two flows.
 *
 * The `message` is user-safe on failure.
 */
export async function deployFlowButtons(
    guildId: string,
    flowId: string,
    deps: DeployFlowButtonsDeps = {}
): Promise<DeployFlowButtonsResult> {
    const getGuild = deps.getGuild ?? defaultGetGuild;
    const repo = deps.repo ?? flowsRepo;

    const guild = await getGuild(guildId);
    if (!guild) {
        return { ok: false, message: 'That server is unavailable right now. Try again in a moment.' };
    }

    const flow = await repo.getByFlowId(flowId);
    if (!flow || flow.guildId !== guildId) {
        return { ok: false, message: `No flow found with id \`${flowId}\` in this server.` };
    }

    /*
     * A disabled flow is refused here rather than at either call site.
     *
     * Deploying one is guaranteed to produce buttons that answer "This flow is
     * currently disabled." to every press — live, public, and wrong-looking. Both
     * surfaces deploy, so a check at one of them would leave the other able to do it;
     * this is the only place both pass through.
     */
    if (!flow.enabled) {
        return {
            ok: false,
            message: `**${flow.name}** is switched off. Turn it on first, or its buttons will just sulk at everyone who presses them.`,
        };
    }

    const plan = planButtonDeployment(flow);
    if (!plan.ok) {
        return { ok: false, message: plan.message };
    }

    const channels = await resolveChannels(guild, plan.destinations);
    if (!channels.ok) {
        return { ok: false, message: channels.message };
    }

    /*
     * Retire first, then post.
     *
     * `flow_button_messages` is insert-only, so without this a second deploy leaves
     * the first message live beside the new one — two sets of buttons for one flow,
     * both routing, and no way to tell from a channel which is current. Reusing
     * `undeployFlowButtons` rather than deleting here keeps one deletion path: it is
     * the thing that knows a hand-deleted message is a success and that a row outlives
     * a failed delete.
     *
     * The order costs something and it is the right way round. If the retire works and
     * the post then fails, the operator has nothing deployed — recoverable by fixing
     * the problem and deploying again. The reverse would post first and orphan the old
     * message on a failed retire, which is unrecoverable without hunting it by hand.
     * The failure message says the old buttons are already gone so nobody wonders
     * whether they are half-deployed.
     */
    const retired = await (deps.undeploy ?? undeployFlowButtons)(guildId, flowId);
    const stuck = retired.results.filter((result) => result.outcome === 'failed');
    if (stuck.length > 0) {
        // Every one of them, as `resolveChannels` does below and for the same
        // reason: `undeployFlowButtons` deliberately carries on past a failure so
        // the operator learns about all of them at once, and collapsing to the
        // first would spend a round trip per stuck channel.
        const explained = stuck
            .map((entry) => `<#${entry.channelId}>: ${entry.explanation ?? 'Discord said no.'}`)
            .join('; ');

        return {
            ok: false,
            message:
                `Couldn't clear this flow's existing buttons, so nothing new was posted — ${explained}. ` +
                'The old buttons are still live — fix that and deploy again.',
        };
    }
    const replaced = retired.results.length > 0;

    const posted: DeployedButtonMessage[] = [];
    for (const { destination, channel } of channels.resolved) {
        const rows = destination.rows.map((row) =>
            new ActionRowBuilder<ButtonBuilder>().addComponents([...row])
        );

        let message: Awaited<ReturnType<TextChannel['send']>>;
        try {
            message = await channel.send({ content: `**${flow.name}**`, components: rows });
        } catch (error) {
            console.error('[flows] Error posting flow trigger buttons:', error);
            /*
             * Exactly one of these, because they are mutually exclusive states and
             * an operator acts on the answer. Saying "nothing is live" beside "one
             * message went out" puts two contradictory facts in one notification,
             * and the reassuring half is the false one. Ordered most-live first:
             * what is already out there matters more than what was taken down.
             */
            const liveState =
                posted.length > 0
                    ? ` ${posted.length} message(s) already went out and are live — deploying again will replace them.`
                    : replaced
                      ? " This flow's previous buttons were already taken down, so nothing of it is live right now."
                      : ' Nothing was posted.';

            return {
                ok: false,
                message:
                    `Could not post in <#${destination.channelId}>. Check the bot's permissions there.` +
                    liveState,
            };
        }

        posted.push({
            channelId: destination.channelId,
            messageId: message.id,
            buttonCount: destination.buttonCount,
        });

        /*
         * Write down where the buttons went, **here** rather than at either call site.
         *
         * Both surfaces deploy — the `/flow-deploy` slash command and the web route — and
         * recording in only one of them would leave the other producing buttons nothing
         * can ever retire. That is the defect this table exists to fix, and putting the
         * write at one call site would leave half of it in place indefinitely.
         *
         * A failure here does not fail the deploy: the message is already posted and those
         * buttons are live. Reporting failure would be a lie about the guild, and the
         * caller has no undo. It is logged loudly instead, because the consequence — a
         * live button with no record — is exactly the orphan this feature is about, and a
         * human needs to know one was just created.
         */
        try {
            await (deps.buttonMessagesRepo ?? flowButtonMessagesRepo).persist({
                guildId,
                flowId,
                channelId: destination.channelId,
                messageId: message.id,
                nodeIds: destination.nodeIds,
            });
        } catch (error) {
            console.error(
                `[flows] Posted trigger buttons for flow ${flowId} as message ${message.id} in channel ${destination.channelId}, but could not record it. Those buttons cannot be retired automatically and must be deleted by hand:`,
                error
            );
        }
    }

    return {
        ok: true,
        flow,
        posted,
        buttonCount: posted.reduce((total, entry) => total + entry.buttonCount, 0),
    };
}

/** A destination paired with the channel it resolved to, so the poster cannot miss. */
interface ResolvedDestination {
    readonly destination: ButtonDestination;
    readonly channel: TextChannel;
}

/**
 * Resolve every destination before posting any of them.
 *
 * Up front rather than per message, because a bad channel found halfway through would
 * already have posted the earlier ones — the partial deploy that decision A exists to
 * prevent. All of them are named in one message so a misconfigured canvas takes one
 * round trip to fix rather than one per channel.
 *
 * **Gone and wrong-type are reported separately.** They need different actions from the
 * operator — one is a deleted or never-created channel, the other a canvas pointing at
 * a voice channel or a category — and a single "not a text channel" sends half of them
 * to edit a flow that is correct.
 *
 * Returns pairs rather than a lookup table, so the posting loop cannot be written in a
 * way that silently drops a destination it fails to find.
 */
async function resolveChannels(
    guild: Guild,
    destinations: readonly ButtonDestination[]
): Promise<{ ok: true; resolved: readonly ResolvedDestination[] } | { ok: false; message: string }> {
    const resolved: ResolvedDestination[] = [];
    const gone: string[] = [];
    const wrongType: string[] = [];

    for (const destination of destinations) {
        // Cache first, then fetch — the repo's usual shape. A cache miss is ordinary
        // for a channel this process has not touched yet, and treating one as "that
        // channel is gone" would refuse a correct flow outright.
        const channel =
            guild.channels.cache.get(destination.channelId) ??
            (await guild.channels.fetch(destination.channelId).catch(() => null));

        if (!channel) {
            gone.push(destination.channelId);
            continue;
        }
        if (channel.type !== ChannelType.GuildText) {
            wrongType.push(destination.channelId);
            continue;
        }

        resolved.push({ destination, channel: channel as TextChannel });
    }

    const complaints: string[] = [];
    if (gone.length > 0) {
        complaints.push(
            `${gone.map((id) => `\`${id}\``).join(', ')} ${gone.length === 1 ? "doesn't exist" : "don't exist"} in this server any more`
        );
    }
    if (wrongType.length > 0) {
        complaints.push(
            `${wrongType.map((id) => `<#${id}>`).join(', ')} ${wrongType.length === 1 ? 'is not a text channel' : 'are not text channels'}`
        );
    }

    if (complaints.length > 0) {
        return {
            ok: false,
            message: `${complaints.join(', and ')}. Point those button triggers somewhere a message can actually go.`,
        };
    }

    return { ok: true, resolved };
}
