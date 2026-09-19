import type { FlowGraph } from '../data/flowGraph';
import type { ResourceBindingTarget } from './bindResourcesToGraph';

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

            targets.push({
                nodeId: node.id,
                configKey: targetKey,
                resourceKey: value,
            });
        }
    }

    return targets;
}
