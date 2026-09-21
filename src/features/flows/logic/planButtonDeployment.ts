import { ButtonBuilder } from 'discord.js';
import { isTriggerStartedBy } from '../blocks/registry';
import { BUTTON_STYLE_MAP, buttonClickConfigSchema } from '../blocks/triggerButtonClick';
import type { FlowEntity } from '../data/flowsSchema';
import type { FlowGraph, FlowNode } from '../data/flowGraph';
import { buildFlowCustomId } from '../utils/customId';
import { collectResourceTargets } from './resourceTargets';

/** Discord's limits on one message's components. Both are hard API errors, not advice. */
const BUTTONS_PER_ROW = 5;
const ROWS_PER_MESSAGE = 5;
export const MAX_BUTTONS_PER_MESSAGE = BUTTONS_PER_ROW * ROWS_PER_MESSAGE;

/** One channel's worth of buttons, already chunked into rows Discord will accept. */
export interface ButtonDestination {
    readonly channelId: string;
    /** Rows of at most five buttons, in author order. */
    readonly rows: readonly (readonly ButtonBuilder[])[];
    /** Which trigger nodes this message will carry, for the button-messages record. */
    readonly nodeIds: readonly string[];
    readonly buttonCount: number;
}

export type ButtonDeploymentPlan =
    | { readonly ok: true; readonly destinations: readonly ButtonDestination[] }
    | { readonly ok: false; readonly message: string };

/**
 * Decide what goes where, without touching Discord.
 *
 * Split out of {@link deployFlowButtons} because every rule that can refuse a deploy
 * is a fact about the graph — an uninstalled destination, a channel over Discord's
 * limit, a node with nowhere to go — and none of them needs a guild to decide. Keeping
 * them here means they are tested against a graph rather than against a mocked client,
 * and it keeps the posting path to "send what the plan says".
 *
 * **Refusals are whole-deploy, never per-button.** Posting the buttons that happen to
 * be ready would leave a flow half-live, with no record of which half and no way to
 * tell by looking; an operator who fixes the rest then gets a second message in the
 * channels that already worked. One refusal naming everything wrong is the only
 * outcome a retry can start from cleanly.
 */
export function planButtonDeployment(flow: FlowEntity): ButtonDeploymentPlan {
    const buttonNodes = flow.graph.nodes.filter((node) =>
        isTriggerStartedBy(node.type, 'buttonClick')
    );
    if (buttonNodes.length === 0) {
        return { ok: false, message: 'This flow has no button-click triggers to deploy.' };
    }

    const pending = pendingDestinations(flow.graph, buttonNodes);
    if (pending.length > 0) {
        /*
         * Named by resource rather than by node: the operator picks what to install
         * by key, and several buttons can be waiting on one channel.
         *
         * Deliberately does not promise that installing will resolve it. A sidecar
         * may name a resource the flow no longer declares — a typo, or a tidied
         * Resources list — and that one never arrives however many installs are run.
         * Save-time validation is what blames an undeclared key precisely; this only
         * has to refuse and say what it is waiting for.
         */
        const names = pending.map((key) => `\`${key}\``).join(', ');
        return {
            ok: false,
            message:
                `${names} ${pending.length === 1 ? "doesn't exist" : "don't exist"} yet, so there is nowhere to put those buttons. ` +
                "Install this flow's resources — or, if that name is stale, repoint the trigger at a channel that exists.",
        };
    }

    const byChannel = new Map<string, { nodes: FlowNode[]; buttons: ButtonBuilder[] }>();
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

        const destination = byChannel.get(parsed.data.channelId) ?? { nodes: [], buttons: [] };
        destination.nodes.push(node);
        destination.buttons.push(
            new ButtonBuilder()
                .setCustomId(buildFlowCustomId(flow.flowId, node.id))
                .setLabel(parsed.data.label)
                .setStyle(BUTTON_STYLE_MAP[parsed.data.style])
        );
        byChannel.set(parsed.data.channelId, destination);
    }

    const destinations: ButtonDestination[] = [];
    for (const [channelId, grouped] of byChannel) {
        /*
         * One message per channel, so a redeploy has exactly one message to replace
         * there. Splitting a 26th button into a second message would double the
         * orphan problem `flow_button_messages` exists to solve — two messages to
         * retire, either of which can fail independently — so the limit refuses
         * instead. Twenty-five triggers into one channel is also well past the point
         * where the answer is a second flow.
         */
        if (grouped.buttons.length > MAX_BUTTONS_PER_MESSAGE) {
            return {
                ok: false,
                message:
                    `<#${channelId}> is set to receive ${grouped.buttons.length} buttons, and one message holds ` +
                    `${MAX_BUTTONS_PER_MESSAGE}. Send some of them somewhere else.`,
            };
        }

        destinations.push({
            channelId,
            rows: chunk(grouped.buttons, BUTTONS_PER_ROW),
            nodeIds: grouped.nodes.map((node) => node.id),
            buttonCount: grouped.buttons.length,
        });
    }

    return { ok: true, destinations };
}

/**
 * Resource keys this flow's buttons are waiting on.
 *
 * A picked resource is stored as a **pair**: `channelId` holds the snowflake and
 * `channelIdKey` records which declaration it came from. Choosing a declared resource
 * deliberately clears the snowflake — see `pendingResourceFields` — so an empty value
 * beside a sidecar is not a broken node, it is one waiting on an install. A node with
 * neither is a genuinely unset destination and is left to schema validation, which
 * blames it by name.
 *
 * Read through {@link collectResourceTargets} rather than by indexing `channelIdKey`
 * directly, so the pair rule is stated once and this agrees with the save-time check by
 * construction. It also means a button trigger that grows a second picker field is
 * covered without editing this function — the same reason that helper derives its
 * targets from the graph instead of from block declarations.
 *
 * Deduplicated, because several buttons pointing at one uninstalled channel is one
 * thing to install, not three.
 */
function pendingDestinations(
    graph: FlowGraph,
    buttonNodes: readonly FlowNode[]
): readonly string[] {
    const nodesById = new Map(buttonNodes.map((node) => [node.id, node]));
    const keys = new Set<string>();

    for (const target of collectResourceTargets(graph)) {
        const node = nodesById.get(target.nodeId);
        if (!node) continue;

        // Already resolved: install writes the snowflake and deliberately leaves the
        // sidecar behind, which is what makes a deleted-and-recreated channel
        // repairable by re-installing. Only an empty value is actually waiting.
        const value = node.data[target.configKey];
        if (value) continue;

        keys.add(target.resourceKey);
    }

    return [...keys];
}

function chunk(buttons: readonly ButtonBuilder[], size: number): readonly (readonly ButtonBuilder[])[] {
    const rows: ButtonBuilder[][] = [];
    for (let index = 0; index < buttons.length; index += size) {
        rows.push(buttons.slice(index, index + size));
    }
    return rows;
}
