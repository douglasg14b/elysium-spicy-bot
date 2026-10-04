/**
 * The few values the builder needs from the server's contract at runtime, read off the
 * generated zod rather than restated: the graph version a save must carry, the palette's
 * sections in order, and the eligibility vocabularies the gate control offers.
 *
 * Each comes from the schema the route declares (`src/web/api/flowBody.ts`,
 * `src/web/api/nodeBody.ts`), so a server that widens one is a browser that has it after
 * `pnpm sdk:generate`, with nothing here to edit.
 */

import {
    zBlockPaletteGroup,
    zEligibility,
    zEligibilityPermission,
    zFlowGraph,
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
