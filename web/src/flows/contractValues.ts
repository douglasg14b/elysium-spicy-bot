/**
 * The few values the builder needs from the server's contract at runtime, read off the
 * generated zod rather than restated: the graph version a save must carry, the palette's
 * sections in order, the eligibility vocabularies the gate control offers, the permission
 * vocabularies the resource editor offers, and the key lengths the slugifiers cut at.
 *
 * Each comes from the schema the route declares (`src/web/api/flowBody.ts`,
 * `src/web/api/nodeBody.ts`, `src/web/api/journeyBody.ts`), so a server that widens one is
 * a browser that has it after `pnpm sdk:generate`, with nothing here to edit.
 */

import {
    zBlockPaletteGroup,
    zEligibility,
    zEligibilityPermission,
    zFlowGraph,
    zFlowGroup,
    zPermissionAccess,
    zPermissionAudience,
    zResourceDeclaration,
    type Eligibility,
} from '@brattybot/web-sdk';

/** The graph-shape version the save endpoint parses with `z.literal`. */
export const FLOW_GRAPH_VERSION = zFlowGraph.shape.version.value;

/** The palette's sections, in the order it shows them. */
export const BLOCK_PALETTE_GROUPS = zBlockPaletteGroup.options;

/** Who a gate can admit, by principal, in the server's order. */
export type EligibilityPrincipal = Eligibility['principal'];

/** Every principal a gate can name, one per arm of the server's union. */
export const ELIGIBILITY_PRINCIPALS: readonly EligibilityPrincipal[] = zEligibility.options.map(
    (arm) => arm.shape.principal.options[0]
);

/** The Discord permissions a gate may name — a curated subset, not every flag. */
export const ELIGIBILITY_PERMISSIONS = zEligibilityPermission.options;

/** Who a resource's permission rule can be about, in the order the editor offers them. */
export const PERMISSION_AUDIENCES = zPermissionAudience.options;

/** How much a permission rule lets its audience do, least to most, as the editor offers them. */
export const PERMISSION_ACCESS_LEVELS = zPermissionAccess.options;

/** The longest key a declared resource may have — what a key derived from a name is cut to. */
export const RESOURCE_KEY_MAX_LENGTH = maximumLengthOf(
    zResourceDeclaration.shape.key.maxLength,
    'ResourceDeclaration.key'
);

/** The longest key the journey a grouping creates may have — what a key derived from its name is cut to. */
export const NEW_JOURNEY_KEY_MAX_LENGTH = maximumLengthOf(
    zFlowGroup.shape.newJourneyKey.unwrap().maxLength,
    'FlowGroup.newJourneyKey'
);

/**
 * A string rule's maximum length, failing as the module loads when the contract declares
 * none — zod reports a missing bound as `null`, and a slug cut at nothing would quietly
 * grow past whatever the server takes instead.
 */
function maximumLengthOf(maxLength: number | null, rule: string): number {
    if (maxLength === null) {
        throw new Error(`The generated contract declares no maximum length for ${rule}, so there is no length to cut a derived key to.`);
    }
    return maxLength;
}
