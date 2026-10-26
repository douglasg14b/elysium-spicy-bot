import { z } from '@hono/zod-openapi';
import type { PublishedFlowState, PublishedResource } from '../../features/flows/logic/publishedFlowState';
import type { PublishedJourneyState } from '../../features/flows/logic/publishedJourneyState';
import { REFUSAL_REASONS } from '../../features/provisioning/logic/unpublishPlan';
import type { ChecksHold, MismatchedChecks, SchemaMatches } from './openApi';

/**
 * A channel or role the journey put in the guild. `refused` means unpublishing leaves it
 * alone, `refusalReason` says which of the reasons with different copy behind them, and
 * `explanation` is the sentence a dialog must show rather than bury under a count.
 */
const PublishedResourceSchema = z
    .object({
        resourceKey: z.string(),
        kind: z.string(),
        name: z.string(),
        discordId: z.string().optional(),
        refused: z.boolean(),
        refusalReason: z.enum(REFUSAL_REASONS).optional(),
        explanation: z.string().optional(),
        /** For `category-has-survivors`: what is still inside, by name. */
        survivors: z.array(z.string()).readonly().optional(),
    })
    .openapi('PublishedResource');

/**
 * Each schema above that states a domain type the routes send as it is, against that type.
 * Gathered here so `__tests__/publishedBody.test-d.ts` can assert them; see {@link SchemaMatches}.
 */
type PublishedBodyChecks = ChecksHold<{
    PublishedResource: SchemaMatches<typeof PublishedResourceSchema, PublishedResource>;
}>;

/** The checks in {@link PublishedBodyChecks} that fail, or `never`. Asserted `never` in `__tests__/publishedBody.test-d.ts`. */
export type PublishedBodyMismatch = MismatchedChecks<PublishedBodyChecks>;

/**
 * What a flow — or a journey — has live in the guild.
 *
 * Shared by `flowRoutes` and `journeyRoutes` rather than duplicated, so the browser holds
 * **one** `PublishedFlowState` type and points both dialogs at it. Two copies would be two
 * chances for a field to be added on one side only.
 */
export const PublishedFlowStateSchema = z
    .object({
        deletableResources: z.array(PublishedResourceSchema).readonly(),
        refusedResources: z.array(PublishedResourceSchema).readonly(),
        /**
         * Settings the journey installed — ticket types — that uninstalling forgets and leaves
         * exactly as they are, each with the server's sentence saying so. Neither deleted nor
         * refused: kept by rule.
         */
        keptSettings: z.array(PublishedResourceSchema).readonly(),
    })
    .openapi('PublishedFlowState', {
        description:
            'What a flow or a journey has live in the guild, as the uninstall would treat it. ' +
            '`keptSettings` are settings (ticket types) that uninstalling forgets and leaves standing.',
    });

/** The response body: `z.infer` of the schema, so the builder below cannot send a member the spec does not describe. */
export type PublishedBody = z.infer<typeof PublishedFlowStateSchema>;

/**
 * The wire shape for what a flow or a journey has live in the guild.
 *
 * Fields are listed explicitly rather than spread from the state. These objects are
 * response bodies: a future field added to the internal state would otherwise reach the
 * wire the moment it was declared, without anyone deciding it should.
 */
export function publishedBody(state: PublishedFlowState | PublishedJourneyState): PublishedBody {
    return {
        deletableResources: state.deletableResources,
        refusedResources: state.refusedResources,
        keptSettings: state.keptSettings,
    };
}
