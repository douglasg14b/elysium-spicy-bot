import {
    ActionRowBuilder,
    ButtonBuilder,
    ChannelType,
    type Guild,
    type TextChannel,
} from 'discord.js';
import { DISCORD_CLIENT } from '../../../discordClient';
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
 */
export function buildFlowTriggerButtons(
    flow: FlowEntity
): { ok: true; buttons: ButtonBuilder[] } | { ok: false; message: string } {
    const buttonNodes = flow.graph.nodes.filter((node) => isTriggerStartedBy(node.type, 'buttonClick'));
    if (buttonNodes.length === 0) {
        return { ok: false, message: 'This flow has no button-click triggers to deploy.' };
    }

    const buttons: ButtonBuilder[] = [];
    for (const node of buttonNodes) {
        const parsed = buttonClickConfigSchema.safeParse(node.data);
        if (!parsed.success) {
            const issues = parsed.error.issues.map((i) => i.message).join(', ');
            return { ok: false, message: `Button node \`${node.id}\` has invalid config: ${issues}` };
        }

        buttons.push(
            new ButtonBuilder()
                .setCustomId(buildFlowCustomId(flow.flowId, node.id))
                .setLabel(parsed.data.label)
                .setStyle(BUTTON_STYLE_MAP[parsed.data.style])
        );
    }

    return { ok: true, buttons };
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
    try {
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(built.buttons);
        const message = await textChannel.send({ content: `**${flow.name}**`, components: [row] });
        return {
            ok: true,
            flow,
            channel: textChannel,
            messageId: message.id,
            buttonCount: built.buttons.length,
        };
    } catch (error) {
        console.error('[flows] Error posting flow trigger buttons:', error);
        return { ok: false, message: 'Could not post in that channel. Check the bot\'s permissions.' };
    }
}
