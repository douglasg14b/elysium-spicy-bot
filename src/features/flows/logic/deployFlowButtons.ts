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
import { isTriggerStartedBy } from '../blocks/registry';
import { BUTTON_STYLE_MAP, buttonClickConfigSchema } from '../blocks/triggerButtonClick';
import { buildFlowCustomId } from '../utils/customId';

export type DeployFlowButtonsResult =
    | { ok: true; flow: FlowEntity; channel: TextChannel; messageId: string; buttonCount: number }
    | { ok: false; message: string };

interface DeployFlowButtonsDeps {
    /** Resolves the guild. Defaults to the live Discord client cache/fetch. */
    getGuild?: (guildId: string) => Promise<Guild | null>;
    repo?: FlowsRepo;
    /** Where the posted message is written down. Overridable for tests. */
    buttonMessagesRepo?: Pick<FlowButtonMessagesRepo, 'persist'>;
}

async function defaultGetGuild(guildId: string): Promise<Guild | null> {
    return (
        DISCORD_CLIENT.guilds.cache.get(guildId) ??
        (await DISCORD_CLIENT.guilds.fetch(guildId).catch(() => null))
    );
}

/**
 * Build the trigger button(s) for a flow. Every `trigger.buttonClick` node
 * becomes one button whose custom_id is `flow:<flowId>:<nodeId>`.
 *
 * Returns the node ids alongside the buttons so the caller can write down which
 * triggers a posted message carries. They were always computed here and previously
 * discarded; re-deriving them at the call site would mean filtering the graph by the
 * same rule twice, and the two copies would drift the day the rule changes.
 */
export function buildFlowTriggerButtons(
    flow: FlowEntity
): { ok: true; buttons: ButtonBuilder[]; nodeIds: string[] } | { ok: false; message: string } {
    const buttonNodes = flow.graph.nodes.filter((node) => isTriggerStartedBy(node.type, 'buttonClick'));
    if (buttonNodes.length === 0) {
        return { ok: false, message: 'This flow has no button-click triggers to deploy.' };
    }

    const buttons: ButtonBuilder[] = [];
    for (const node of buttonNodes) {
        const parsed = buttonClickConfigSchema.safeParse(node.data);
        if (!parsed.success) {
            // Named by field, as `nodeDataValidation` already does. Dropping the
            // path was survivable while this block's only settable fields were a
            // label and a style — both of which fail with a message that names
            // itself. An eligibility rule does not: a half-filled one reports
            // "Invalid input", which sends an author looking at the button.
            const issues = parsed.error.issues
                .map((issue) => {
                    const field = issue.path.join('.');
                    return field ? `${field}: ${issue.message}` : issue.message;
                })
                .join(', ');
            return { ok: false, message: `Button node \`${node.id}\` has invalid config: ${issues}` };
        }

        buttons.push(
            new ButtonBuilder()
                .setCustomId(buildFlowCustomId(flow.flowId, node.id))
                .setLabel(parsed.data.label)
                .setStyle(BUTTON_STYLE_MAP[parsed.data.style])
        );
    }

    return { ok: true, buttons, nodeIds: buttonNodes.map((node) => node.id) };
}

/**
 * Single load-validate-and-post path for deploying a flow's trigger buttons,
 * shared by the `/flow-deploy` slash command and the web deploy route. Mirrors
 * {@link setWarningsModChannel} — a discriminated result, no presentation glue.
 *
 * The `message` is user-safe on failure.
 */
export async function deployFlowButtons(
    guildId: string,
    flowId: string,
    channelId: string,
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

    const built = buildFlowTriggerButtons(flow);
    if (!built.ok) {
        return { ok: false, message: built.message };
    }

    const channel = guild.channels.cache.get(channelId) ?? null;
    if (!channel || channel.type !== ChannelType.GuildText) {
        return { ok: false, message: 'Pick a text channel in this server to post the buttons in.' };
    }

    const textChannel = channel as TextChannel;
    let message: Awaited<ReturnType<TextChannel['send']>>;
    try {
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(built.buttons);
        message = await textChannel.send({ content: `**${flow.name}**`, components: [row] });
    } catch (error) {
        console.error('[flows] Error posting flow trigger buttons:', error);
        return { ok: false, message: 'Could not post in that channel. Check the bot\'s permissions.' };
    }

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
            channelId,
            messageId: message.id,
            nodeIds: built.nodeIds,
        });
    } catch (error) {
        console.error(
            `[flows] Posted trigger buttons for flow ${flowId} as message ${message.id} in channel ${channelId}, but could not record it. Those buttons cannot be retired automatically and must be deleted by hand:`,
            error
        );
    }

    return {
        ok: true,
        flow,
        channel: textChannel,
        messageId: message.id,
        buttonCount: built.buttons.length,
    };
}
