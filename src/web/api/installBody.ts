/*
 * The vocabularies (`UNDEPLOY_OUTCOMES`, `UNPUBLISH_OUTCOMES`, `PLAN_ACTIONS`,
 * `RESOURCE_KINDS`) come from the modules that define them rather than through the
 * provisioning barrel: they are read while this module loads, and route tests that mock
 * the barrel with only the functions they exercise would otherwise hand `z.enum` nothing.
 * A test that mocks one of these modules has to keep its real exports (`importOriginal`).
 */
import { z } from '@hono/zod-openapi';
import {
    UNDEPLOY_OUTCOMES,
    type UndeployedButtonMessage,
} from '../../features/flows/logic/undeployFlowButtons';
import type { DeployedButtonMessage } from '../../features/flows/logic/deployFlowButtons';
import type { AppliedResource } from '../../features/provisioning/logic/applyInstallPlan';
import {
    UNPUBLISH_OUTCOMES,
    type UnpublishedResource,
} from '../../features/provisioning/logic/applyUnpublishPlan';
import { isPlanApplicable, PLAN_ACTIONS, type InstallPlan } from '../../features/provisioning/logic/installPlan';
import { RESOURCE_KINDS } from '../../features/provisioning/logic/resourceDeclaration';
import type { InstallRunOutcome } from '../../features/provisioning/logic/runInstall';
import { ErrorBodySchema, type SchemaMatches } from './openApi';

/**
 * What putting a flow into the guild, and taking it back out, says on the wire: its
 * buttons (deploy, undeploy) and its declared channels and roles (install plan, install,
 * unpublish).
 *
 * Schemas, as in `flowBody.ts`: each is what its route declares and what the dashboard
 * SDK's types are generated from. Domain types sent as they are stay where they live and
 * are held to their schema both ways by {@link SchemaMatches}; bodies built here are
 * typed by `z.infer`. The undeploy and unpublish results are the journey routes' shapes
 * too, for when those convert.
 */

/** One message `deploy` posted: where it went and how many buttons it carries. */
const DeployedButtonMessageSchema = z
    .object({
        channelId: z.string(),
        messageId: z.string(),
        buttonCount: z.number(),
    })
    .openapi('DeployedButtonMessage');

const deployedButtonMessageSchemaMatches: SchemaMatches<
    typeof DeployedButtonMessageSchema,
    DeployedButtonMessage
> = true;
void deployedButtonMessageSchemaMatches;

/** A deploy that posted: one message per destination channel. A refusal is a 400. */
export const DeployResultSchema = z
    .object({
        ok: z.literal(true),
        posted: z.array(DeployedButtonMessageSchema).readonly(),
    })
    .openapi('DeployResult');

/** What became of one recorded button message. `explanation` is set for `failed`. */
const UndeployedButtonMessageSchema = z
    .object({
        channelId: z.string(),
        messageId: z.string(),
        outcome: z.enum(UNDEPLOY_OUTCOMES),
        explanation: z.string().optional(),
    })
    .openapi('UndeployedButtonMessage');

const undeployedButtonMessageSchemaMatches: SchemaMatches<
    typeof UndeployedButtonMessageSchema,
    UndeployedButtonMessage
> = true;
void undeployedButtonMessageSchemaMatches;

export const UndeployResultSchema = z
    .object({
        results: z.array(UndeployedButtonMessageSchema).readonly(),
    })
    .openapi('UndeployResult');

/** What became of one resource a teardown reached. `explanation` is set for `refused` and `failed`. */
const UnpublishedResourceSchema = z
    .object({
        resourceKey: z.string(),
        kind: z.enum(RESOURCE_KINDS),
        name: z.string(),
        outcome: z.enum(UNPUBLISH_OUTCOMES),
        explanation: z.string().optional(),
    })
    .openapi('UnpublishedResource');

const unpublishedResourceSchemaMatches: SchemaMatches<typeof UnpublishedResourceSchema, UnpublishedResource> = true;
void unpublishedResourceSchemaMatches;

export const UnpublishResultSchema = z
    .object({
        results: z.array(UnpublishedResourceSchema).readonly(),
    })
    .openapi('UnpublishResult');

/**
 * One line of an install plan. `discordId` is set for `adopt`, `recover` and `reuse`,
 * and on a `blocked` name collision; `reason` says why an item is blocked, why a create
 * replaces something deleted, or what an interrupted install left for a `recover`.
 */
const InstallPlanItemSchema = z
    .object({
        resourceKey: z.string(),
        kind: z.enum(RESOURCE_KINDS),
        action: z.enum(PLAN_ACTIONS),
        name: z.string(),
        discordId: z.string().optional(),
        reason: z.string().optional(),
    })
    .openapi('InstallPlanItem');

/**
 * The reviewable plan for installing what a flow declares.
 *
 * Every item, including the ones needing no work: "what will this do to my server" is
 * only answerable if the unchanged things are visible too. `applicable` is the server's
 * own `isPlanApplicable`, on the wire rather than re-derived in the browser.
 */
export const InstallPlanSchema = z
    .object({
        journeyKey: z.string(),
        applicable: z.boolean(),
        /** Guild-level problems stopping the whole apply — permissions, role hierarchy. */
        blockers: z.array(z.string()).readonly(),
        items: z.array(InstallPlanItemSchema).readonly(),
    })
    .openapi('InstallPlan', {
        description:
            'What installing would do, item by item, unchanged items included. `applicable` is false ' +
            'when any blocker or blocked item stands in the way; the install re-checks it regardless.',
    });

/**
 * The 409 an install answers when it will not go ahead. `plan` is there when the reason
 * is that the guild changed since the preview: the rebuilt plan, so the operator is shown
 * what changed rather than the plan they already agreed to. Without it, the journey is
 * not this flow's to install, or cannot be installed as shared server structure.
 */
export const InstallRefusalSchema = ErrorBodySchema.extend({
    plan: InstallPlanSchema.optional(),
}).openapi('InstallRefusal');

/** A resource the install actually put in the guild. */
const InstalledResourceSchema = z
    .object({
        resourceKey: z.string(),
        discordId: z.string(),
        action: z.enum(['created', 'adopted', 'reused']),
        name: z.string(),
    })
    .openapi('InstalledResource');

const installedResourceSchemaMatches: SchemaMatches<typeof InstalledResourceSchema, AppliedResource> = true;
void installedResourceSchemaMatches;

/**
 * What an install did.
 *
 * `failure` beside a non-empty `applied` is a **partial install**, a legitimate state
 * rather than an error: what was created is real and bound, and re-running install
 * continues from there. `unresolved` names the resource keys some node picked that still
 * have no id, once each. `writeBackFailed` is its own flag because a write-back that
 * threw and a journey nothing references both write zero settings, and only the first
 * leaves the operator's flows pointing at nothing.
 */
export const InstallResultSchema = z
    .object({
        applied: z.array(InstalledResourceSchema).readonly(),
        failure: z.string().optional(),
        writtenCount: z.number(),
        updatedFlowIds: z.array(z.string()).readonly(),
        writeBackFailed: z.boolean(),
        unresolved: z.array(z.string()),
    })
    .openapi('InstallResult');

/**
 * The wire shape for an install plan.
 *
 * `reason` carries both the blocker's explanation and the note on a create that replaces
 * something deleted, so a client shows it without asking which kind it is. Items are
 * copied field by field so `parentKey`, which the plan uses to order creates, stays off
 * the wire.
 */
export function installPlanBody(plan: InstallPlan): z.infer<typeof InstallPlanSchema> {
    return {
        journeyKey: plan.journeyKey,
        applicable: isPlanApplicable(plan),
        blockers: plan.blockers,
        items: plan.items.map((item) => ({
            resourceKey: item.resourceKey,
            kind: item.kind,
            action: item.action,
            name: item.name,
            discordId: item.discordId,
            reason: item.reason,
        })),
    };
}

/** The wire shape for an install that ran, partially or in full. */
export function installResultBody(
    outcome: Extract<InstallRunOutcome, { status: 'applied' }>
): z.infer<typeof InstallResultSchema> {
    return {
        applied: outcome.applied,
        failure: outcome.failure,
        writtenCount: outcome.writeBack.writtenCount,
        updatedFlowIds: outcome.writeBack.updatedFlowIds,
        // On the wire rather than inferred from a zero count: a write-back that
        // threw and a journey nothing references both write zero settings, and
        // only one of them means the operator's flows are now broken.
        writeBackFailed: outcome.writeBack.failed === true,
        // Named individually rather than counted: "3 unresolved" tells an operator
        // nothing they can act on, whereas the resource key is the thing they
        // declared. Deduplicated because one key can be picked by several nodes.
        unresolved: [...new Set(outcome.writeBack.unresolved.map((target) => target.resourceKey))],
    };
}
