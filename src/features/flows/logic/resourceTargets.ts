import { isFieldVisible, type BlockControlType } from '../blocks/manifest';
import { getBlockDefinition } from '../blocks/registry';
import type { FlowGraph, FlowNode } from '../data/flowGraph';
import type { ResourceBindingTarget } from './bindResourcesToGraph';

/**
 * The controls that write a `<field>Key` sidecar when a declared resource is picked.
 *
 * Matches the builder's pickers (`PickerControls.tsx`, `TicketTypePickerControl.tsx`). The
 * browser reads this very list off the spec (`ResourcePickerControl`, registered in
 * `src/web/api/openApiDocument.ts`) to know whose emptiness is the server's to judge. A
 * ticket type joined on 2026-10-10, when a journey became able to declare one.
 */
export const RESOURCE_PICKER_CONTROL_TYPES = [
    'rolePicker',
    'channelPicker',
    'categoryPicker',
    'ticketTypePicker',
] as const satisfies readonly BlockControlType[];

/** {@link RESOURCE_PICKER_CONTROL_TYPES} as a set, for the scan's lookups. */
export const RESOURCE_PICKER_CONTROLS: ReadonlySet<BlockControlType> = new Set<BlockControlType>(
    RESOURCE_PICKER_CONTROL_TYPES
);

/**
 * The config-key suffix marking a picker's resource key.
 *
 * A picked resource is stored as two keys, not one structured value: `roleId` keeps
 * holding a snowflake because the block hands it straight to `roles.add()`, and
 * `roleIdKey` records which declaration it came from. This constant is the contract
 * between the builder that writes the pair and the write-back that reads it.
 *
 * Mirrored by `resourceKeyFieldFor` in the web control library. Duplicated rather
 * than shared because the two packages have no common module, and a three-character
 * suffix is a cheaper duplication than a dependency between them — but a test asserts
 * they agree, so drift is caught rather than discovered at run time.
 */
export const RESOURCE_KEY_SUFFIX = 'Key';

/**
 * Find every node config that names a declared resource.
 *
 * Derived from the graph rather than declared per block, because which fields a node
 * fills is authoring data: two nodes of the same block type can name different
 * resources, and one may use a real snowflake while the other waits on an install.
 *
 * Only string values count. A non-string under a `*Key` config key did not come from
 * a picker, and treating it as a resource key would send a number to a lookup that
 * expects one — better to ignore it here and let schema validation report the real
 * problem.
 *
 * **Blind to `visibleWhen`, on purpose.** This is what install writes ids back
 * through, and writing an id into a hidden field is harmless — the engine leaves hidden
 * fields out — while skipping it would leave the field empty once the author shows it
 * again, refusing switch-on over a resource that is installed. A question about
 * whether a field is *waiting* on a resource asks {@link collectApplicableResourceTargets}.
 *
 * **Not every `*Key` is a sidecar.** `<k>Key` counts only when the block has a field
 * `<k>` whose control is a picker. The scan used to be purely lexical, so Pick Random's
 * own `outputKey` — the name of the variable it records — read as a sidecar for a field
 * `output` that does not exist, and readiness refused to switch on every Pick Random flow
 * over "a resource this flow doesn't declare". A node whose block this build does not
 * know is read as it stands, as {@link collectApplicableResourceTargets} reads one. Needs
 * the block registry, so a caller must have awaited discovery.
 */
export function collectResourceTargets(graph: FlowGraph): ResourceBindingTarget[] {
    const targets: ResourceBindingTarget[] = [];

    for (const node of graph.nodes) {
        for (const [configKey, value] of Object.entries(node.data ?? {})) {
            if (!configKey.endsWith(RESOURCE_KEY_SUFFIX)) continue;
            if (typeof value !== 'string' || !value) continue;

            const targetKey = configKey.slice(0, -RESOURCE_KEY_SUFFIX.length);
            // A bare `Key` config entry names no field to write into. Skipped rather
            // than written to an empty key, which would corrupt the node's data.
            if (!targetKey) continue;
            if (!isPickerSidecar(node, targetKey)) continue;

            targets.push({
                nodeId: node.id,
                configKey: targetKey,
                resourceKey: value,
            });
        }
    }

    return targets;
}

/**
 * Whether `<targetKey>Key` on this node is a picker's sidecar: the block has a field
 * `targetKey` drawn by a picker. An unknown block is lenient — read as it stands.
 */
function isPickerSidecar(node: FlowNode, targetKey: string): boolean {
    const block = getBlockDefinition(node.type);
    if (!block) return true;
    return block.configFields.some(
        (field) => field.key === targetKey && RESOURCE_PICKER_CONTROLS.has(field.control)
    );
}

/**
 * The targets of {@link collectResourceTargets} whose field currently applies.
 *
 * For the readers asking whether a field is waiting on a resource — readiness, the
 * switch-on gate, deploy. A picker its `visibleWhen` hides does not apply, so its
 * sidecar must neither hold the flow back nor be blamed for naming an undeclared key;
 * shown again, it is judged again. A node whose block this build does not know is read
 * as it stands. Needs the block registry, so a caller must have awaited discovery.
 */
export function collectApplicableResourceTargets(graph: FlowGraph): ResourceBindingTarget[] {
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));

    return collectResourceTargets(graph).filter((target) => {
        const node = nodesById.get(target.nodeId);
        const fields = node ? (getBlockDefinition(node.type)?.configFields ?? []) : [];
        const field = fields.find((candidate) => candidate.key === target.configKey);
        return !field || !node || isFieldVisible(field, fields, node.data ?? {});
    });
}
