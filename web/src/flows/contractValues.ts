/**
 * The few values the builder needs from the server's contract at runtime, read off the
 * generated zod rather than restated: the graph version a save must carry, the palette's
 * sections in order, the eligibility vocabularies the gate control offers, the days the
 * days control offers, the permission vocabularies the resource editor offers, which
 * resource kinds are Discord objects, which controls write a resource sidecar, and the key
 * lengths the slugifiers cut at.
 *
 * Each comes from the schema the route declares (`src/web/api/flowBody.ts`,
 * `src/web/api/nodeBody.ts`, `src/web/api/journeyBody.ts`), so a server that widens one is
 * a browser that has it after `pnpm sdk:generate`, with nothing here to edit.
 */

import {
    zBlockDayKey,
    zResourcePickerControl,
    zBlockPaletteGroup,
    zDiscordResourceKind,
    zEligibility,
    zEligibilityPermission,
    zFlowGraph,
    zFlowGroup,
    zPermissionAccess,
    zPermissionAudience,
    zResourceDeclaration,
    type BlockConfigField,
    type DiscordResourceKind,
    type Eligibility,
    type ResourceKind,
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

/** The seven keys a `daysOfWeek` control stores, Monday first — the order it offers them in. */
export const BLOCK_DAY_KEYS = zBlockDayKey.options;

/**
 * The resource kinds that are objects in the Discord guild — categories, channels and
 * roles, each with a snowflake. A `ticketType` is a row in the ticket settings named by its
 * key: no parent, no channel permissions, nothing to adopt by id, no name to collide with
 * in Discord. Anything that reaches for the channel or role list asks
 * {@link isDiscordResourceKind} first.
 */
export const DISCORD_RESOURCE_KINDS: readonly DiscordResourceKind[] = zDiscordResourceKind.options;

/** Whether a resource kind is an object in the Discord guild, rather than a ticket type. */
export function isDiscordResourceKind(kind: ResourceKind): kind is DiscordResourceKind {
    return (DISCORD_RESOURCE_KINDS as readonly ResourceKind[]).includes(kind);
}

/**
 * The controls that write a `<field>Key` sidecar when a declared resource is picked — the
 * fields whose emptiness, beside a sidecar, is the server's to judge (`liveFieldIssues.ts`).
 */
export const RESOURCE_PICKER_CONTROLS: ReadonlySet<BlockConfigField['control']> = new Set<BlockConfigField['control']>(
    zResourcePickerControl.options
);

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
