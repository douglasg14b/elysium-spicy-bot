import type { Guild } from 'discord.js';
import { isFieldVisible, type BlockConfigField } from '../blocks/manifest';
import { getBlockDefinition } from '../blocks/registry';
import type { FlowGraph } from '../data/flowGraph';
import { isVariablePickerField } from '../engine/copyRendering';
import type { FlowValidationIssue } from '../engine/nodeDataValidation';
import { roleChangeRefusal } from './roleSafety';

/** The pickers whose value is a Discord id in the flow's own server. */
type GuildObjectControl = Extract<BlockConfigField['control'], 'channelPicker' | 'categoryPicker' | 'rolePicker'>;

/** What to say when a picker's id is not in the server, by control. */
const NOT_IN_GUILD: Readonly<Record<GuildObjectControl, string>> = {
    channelPicker: "That channel isn't in this server. Pick one from the list.",
    categoryPicker: "That category isn't in this server. Pick one from the list.",
    rolePicker: "That role isn't in this server. Pick one from the list.",
};

function isGuildObjectControl(control: BlockConfigField['control']): control is GuildObjectControl {
    return Object.hasOwn(NOT_IN_GUILD, control);
}

/**
 * What is wrong with the ids a graph's pickers hold, judged against the server the flow
 * belongs to.
 *
 * The half of readiness only the guild can answer, so it lives beside
 * `flowReadinessIssues` rather than inside it — that one is a pure question about the graph,
 * asked too by the seed script, which has no Discord client. Every caller holding a guild
 * asks both through {@link flowReadinessIssuesInGuild}, so the builder's marks, the list's
 * count and the switch-on refusal all agree.
 *
 * Two rules:
 *
 *  - **A picked channel, category or role must be one of this server's.** Nothing else
 *    stopped a graph naming another server's channel, and a client-wide lookup at run time
 *    would then post there as the bot. The answer comes from the guild's cache — the same
 *    cache the builder's pickers list from — so it never asks Discord, and an id that is not
 *    here reads the same whether it was deleted or belongs elsewhere: the sentence says only
 *    that it is not in this server.
 *  - **A role picker on a block that changes roles** (`capabilities: ['manageRoles']`) must
 *    name a role a flow may give or take — see `roleChangeRefusal`.
 *
 * Skipped, because another check already owns them: an empty value (unset, or waiting on an
 * install — `pendingResourceFields`), a `{{var}}` in a picker that takes one (resolved at run
 * time, its name checked by `authoredGraphIssues`), a field its `visibleWhen` hides, and a
 * node whose block this build does not know (`validateNodeData` reports it).
 *
 * Issues name their node and field, the shape every other readiness issue takes, so the
 * builder marks the control. Needs the block registry, so a caller must have awaited
 * discovery. Touches the guild's caches only for a value it has to judge.
 */
export function guildReferenceIssues(graph: FlowGraph, guild: Guild): readonly FlowValidationIssue[] {
    const issues: FlowValidationIssue[] = [];

    for (const node of graph.nodes) {
        const block = getBlockDefinition(node.type);
        if (!block) continue;
        const changesRoles = block.capabilities.includes('manageRoles');

        for (const field of block.configFields) {
            if (!isGuildObjectControl(field.control)) continue;
            if (!isFieldVisible(field, block.configFields, node.data)) continue;

            const value = node.data[field.key];
            if (typeof value !== 'string' || !value) continue;
            if (isVariablePickerField(field) && value.includes('{{')) continue;

            const problem =
                field.control === 'rolePicker'
                    ? roleProblem(guild, value, changesRoles)
                    : guild.channels.cache.get(value)
                      ? undefined
                      : NOT_IN_GUILD[field.control];
            if (problem) {
                issues.push({ nodeId: node.id, field: field.key, message: problem });
            }
        }
    }

    return issues;
}

/** Why a role picker's id is refused, or `undefined`. */
function roleProblem(guild: Guild, roleId: string, changesRoles: boolean): string | undefined {
    const role = guild.roles.cache.get(roleId);
    if (!role) {
        return NOT_IN_GUILD.rolePicker;
    }
    return changesRoles ? roleChangeRefusal(guild, role) : undefined;
}
