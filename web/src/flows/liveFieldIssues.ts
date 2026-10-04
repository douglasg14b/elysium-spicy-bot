/**
 * Checking a block's config fields as the author types, against the rules the SDK carries
 * for every block (`zFlowBlockFieldRules`, generated from each block's `configSchema` with
 * the server's own sentences — `src/features/flows/logic/blockFieldRules.ts`).
 *
 * Nothing here knows a block type, a control or a rule, and nothing has to be added for
 * one: a block's rules arrive with the SDK, and are never fetched or reworded here. The two
 * things this file does decide are not rules: a field its `visibleWhen` hides does not
 * apply, and a field's emptiness beside a resource-key sidecar is the server's to judge.
 *
 * **May miss a problem, must never invent one.** The server stays the authority; it is
 * re-asked as a field loses focus and decides everything the generated rules leave out.
 *
 * The rules are handed in — `zFlowBlockFieldRules.shape`, by `useFlowIssues` — rather than
 * imported here, so the root workspace's gate can run these very functions against the
 * server (`src/features/flows/logic/__tests__/blockFieldRules.test.ts`): nothing under
 * `src/` can resolve the SDK package at run time, so that gate takes the same generated
 * rules by relative path and hands them in.
 */

import type { BlockConfigField, FlowNode, FlowValidationIssue, NodeDescriptor } from '@brattybot/web-sdk';
import { fieldProblems, type FieldCheck } from '../api/fieldProblems';
import { resourceKeyFieldFor } from './controls/types';
import { isFieldVisible } from './variables';

/** One block's generated rules, as far as checking a config against them goes. */
interface BlockRuleParser {
    readonly safeParse: (config: unknown) => FieldCheck;
}

/** Each block's rules, keyed by block type: `zFlowBlockFieldRules.shape`. */
export type FieldRulesByBlockType = Readonly<Record<string, BlockRuleParser>>;

/**
 * The first problem with each field of `config`, by the rules of `type`'s block.
 *
 * A type with no rules — a block added without `pnpm sdk:generate` — gets no live checks:
 * an under-report, which the stale-SDK test fails the suite over. Looked up as an own key,
 * so a node whose type names an `Object.prototype` member finds nothing either.
 */
function problemsWith(
    rules: FieldRulesByBlockType,
    type: string,
    config: Record<string, unknown>
): Readonly<Partial<Record<string, string>>> {
    return Object.hasOwn(rules, type) ? fieldProblems(rules[type].safeParse(config)) : {};
}

/**
 * Whether this field's emptiness is the server's to judge: a resource-key sidecar sits
 * beside it.
 *
 * A picker left empty because it names a resource the flow declares but has not
 * installed is ready, not missing — and whether the key is really declared is the
 * server's call (`pendingResourceFields`). The server finds sidecars by their name alone,
 * whatever control wrote them (`collectResourceTargets`), so this does too: asking which
 * controls write one would be a second, narrower copy of a rule that is not about
 * controls.
 */
function emptinessIsTheServers(field: BlockConfigField, config: Record<string, unknown>): boolean {
    const sidecar = config[resourceKeyFieldFor(field.key)];
    return typeof sidecar === 'string' && sidecar !== '';
}

/**
 * The complaint about one field, given the problems its block's rules found in the config.
 *
 * None for a field its `visibleWhen` hides: it does not apply, and whatever it still
 * holds — a long value typed before the author switched it off — is nothing they can
 * see or need to fix. The server leaves it out before parsing (`visibleNodeData`), so
 * the two agree.
 */
function complaintAbout(
    descriptor: NodeDescriptor,
    field: BlockConfigField,
    config: Record<string, unknown>,
    problems: Readonly<Partial<Record<string, string>>>
): string | undefined {
    if (!isFieldVisible(field, descriptor.configFields, config)) {
        return undefined;
    }

    const value = config[field.key];
    // Every rule, not just a minimum: the server forgives a sidecar'd field's emptiness
    // whatever refuses it (`isEmptyValue` in `nodeDataValidation.ts`). A value that is
    // there is still checked.
    if ((value === undefined || value === '') && emptinessIsTheServers(field, config)) {
        return undefined;
    }
    return problems[field.key];
}

/** The complaint about one field of one node, as the author leaves it now. */
export function fieldIssue(
    descriptor: NodeDescriptor,
    field: BlockConfigField,
    config: Record<string, unknown>,
    rules: FieldRulesByBlockType
): string | undefined {
    return complaintAbout(descriptor, field, config, problemsWith(rules, descriptor.type, config));
}

/**
 * The config field a key written into `node.data` belongs to: the field itself, or the
 * picker whose resource-key sidecar it is. Undefined for a key no drawn field owns.
 */
export function fieldOwning(descriptor: NodeDescriptor, configKey: string): string | undefined {
    return descriptor.configFields.find(
        (field) => field.key === configKey || resourceKeyFieldFor(field.key) === configKey
    )?.key;
}

/**
 * The live complaints about the fields named in `edited`, across the graph.
 *
 * Only edited fields: a block just dropped on the canvas is not covered in red before
 * its author has touched anything. The server says what is wrong with the rest.
 */
export function liveFieldIssues(
    nodes: readonly FlowNode[],
    catalog: readonly NodeDescriptor[],
    edited: ReadonlyMap<string, ReadonlySet<string>>,
    rules: FieldRulesByBlockType
): FlowValidationIssue[] {
    const issues: FlowValidationIssue[] = [];

    for (const node of nodes) {
        const fields = edited.get(node.id);
        if (!fields) continue;
        const descriptor = catalog.find((entry) => entry.type === node.type);
        if (!descriptor) continue;

        const problems = problemsWith(rules, node.type, node.data);
        for (const field of descriptor.configFields) {
            if (!fields.has(field.key)) continue;
            const message = complaintAbout(descriptor, field, node.data, problems);
            if (message) issues.push({ nodeId: node.id, field: field.key, message });
        }
    }

    return issues;
}
