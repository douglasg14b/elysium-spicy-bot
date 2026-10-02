/**
 * Checking a field as the author types, from the rules the server derived off the
 * block's schema (`NodeDescriptor.fieldChecks`).
 *
 * Nothing here knows a block type or a control, and nothing has to be added for either:
 * a block's checks arrive with its descriptor, and the one thing about emptiness only
 * the server can judge — a resource-key sidecar — is found by name, as the server finds
 * it.
 *
 * **May miss a problem, must never invent one.** The server stays the authority; it is
 * re-asked as a field loses focus and decides everything this cannot see. A complaint
 * here that the server would not make is the worse failure, so wherever the answer
 * depends on something only the server knows, this says nothing.
 *
 * Imports only types and the sidecar naming rule, so the root workspace's parity test
 * can run the very function the browser runs (`src/features/flows/logic/__tests__/fieldChecks.test.ts`).
 */

import type { BlockConfigField, FieldCheck, FlowNode, FlowValidationIssue, NodeDescriptor } from '../api/types';
import { resourceKeyFieldFor } from './controls/types';

/**
 * The first of `checks` that `value` fails, if any.
 *
 * Mirrors `failedFieldCheck` in `src/features/flows/logic/fieldChecks.ts` rule for
 * rule; the parity test asks both about every field of every block.
 */
export function failedFieldCheck(checks: readonly FieldCheck[], value: unknown): FieldCheck | undefined {
    return checks.find((check) => !passes(check, value));
}

function passes(check: FieldCheck, value: unknown): boolean {
    switch (check.rule) {
        case 'required':
            return value !== undefined && value !== '';
        case 'integer':
            return typeof value !== 'number' || Number.isInteger(value);
        case 'minLength':
            return typeof value !== 'string' || value.length >= check.limit;
        case 'maxLength':
            return typeof value !== 'string' || value.length <= check.limit;
        case 'minimum':
            return typeof value !== 'number' || value >= check.limit;
        case 'maximum':
            return typeof value !== 'number' || value <= check.limit;
        case 'exclusiveMinimum':
            return typeof value !== 'number' || value > check.limit;
        case 'exclusiveMaximum':
            return typeof value !== 'number' || value < check.limit;
        case 'minItems':
            return !Array.isArray(value) || value.length >= check.limit;
        case 'maxItems':
            return !Array.isArray(value) || value.length <= check.limit;
    }
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

/** The complaint about one field of one node, as the author leaves it now. */
export function fieldIssue(
    descriptor: NodeDescriptor,
    field: BlockConfigField,
    config: Record<string, unknown>
): string | undefined {
    const value = config[field.key];
    // Every rule, not just `required`: a picker's `min(1)` refuses the same empty
    // string, and the server forgives both (`isEmptyValue` in `nodeDataValidation.ts`).
    // A value that is there is still checked.
    if ((value === undefined || value === '') && emptinessIsTheServers(field, config)) {
        return undefined;
    }
    return failedFieldCheck(descriptor.fieldChecks[field.key] ?? [], value)?.message;
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
    edited: ReadonlyMap<string, ReadonlySet<string>>
): FlowValidationIssue[] {
    const issues: FlowValidationIssue[] = [];

    for (const node of nodes) {
        const fields = edited.get(node.id);
        if (!fields) continue;
        const descriptor = catalog.find((entry) => entry.type === node.type);
        if (!descriptor) continue;

        for (const field of descriptor.configFields) {
            if (!fields.has(field.key)) continue;
            const message = fieldIssue(descriptor, field, node.data);
            if (message) issues.push({ nodeId: node.id, field: field.key, message });
        }
    }

    return issues;
}
