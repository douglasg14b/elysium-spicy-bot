import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { flowsRepo } from '../../features/flows/data/flowsRepo';
import { getPublishedJourneyState } from '../../features/flows/logic/publishedJourneyState';
import {
    undeployFlowButtons,
    type UndeployedButtonMessage,
} from '../../features/flows/logic/undeployFlowButtons';
import { flowJourneyLinksRepo } from '../../features/provisioning/data/flowJourneyLinksRepo';
import { DuplicateJourneyKeyError, journeysRepo } from '../../features/provisioning/data/journeysRepo';
import type { JourneyEntity } from '../../features/provisioning/data/journeysSchema';
import { resourceBindingsRepo } from '../../features/provisioning/data/resourceBindingsRepo';
import { planJourneyMerge } from '../../features/provisioning/logic/journeyMergePlan';
import { resolveFlowJourney } from '../../features/provisioning/logic/resolveFlowJourney';
import {
    otherFlowsOnJourney,
    sharedJourneyRefusal,
} from '../../features/provisioning/logic/sharedJourneyGuard';
import { parseDeclaredRoleReference } from '../../features/provisioning/logic/declaredRoleReference';
import {
    PERMISSION_ACCESS_LEVELS,
    PERMISSION_AUDIENCES,
} from '../../features/provisioning/logic/permissionIntent';
import {
    RESOURCE_KINDS,
    ResourceDeclarationError,
} from '../../features/provisioning/logic/resourceDeclaration';
import {
    previewDrift,
    previewOrphans,
    previewUnpublish,
    repairDrift,
    unpublishJourney,
} from '../../features/provisioning';
import { toDeclarationFromRow } from '../../features/provisioning/data/journeysRepo';
import { guildSettingsRepo } from '../../features-system/guild-settings';
import type { AppEnv } from '../types';
import { driftBody } from './driftBody';
import { flowNameInGuild } from './flowNameInGuild';
import { publishedBody } from './publishedBody';

/**
 * Journey CRUD. Mounted under the `/api/guilds` route group, so `requireAuth` and
 * `requireGuildAccess` have already run and `c.get('guild')` is the resolved guild.
 *
 * This is the surface that makes a journey operator-authored. 5A shipped with
 * journeys as TypeScript constants, which meant the engine was neutral about their
 * content and an operator still could not create one.
 */

/**
 * A resource key, constrained to what is safe to embed in a Discord custom_id and
 * readable in a diagnostic: lowercase, digits, hyphens.
 *
 * Restrictive on purpose. The key appears in `resource_bindings`, in node configs,
 * and in button custom_ids which Discord caps at 100 characters — permitting
 * arbitrary text would push the failure to whichever of those hit its limit first,
 * long after the operator typed it.
 */
const resourceKeySchema = z
    .string()
    .min(1, 'Give the resource a key.')
    .max(64, 'Resource keys cap at 64 characters.')
    .regex(
        /^[a-z0-9]+(-[a-z0-9]+)*$/,
        'Resource keys use lowercase letters, numbers and single hyphens (for example `qa-channel`).'
    );

/**
 * One entry in a permission's `roleIds`: a Discord snowflake, or a reference to a
 * role this journey declares.
 *
 * A reference is `resource:<key>` — the key of a role the same journey creates, which
 * has no snowflake until install. Both are strings in the same array, made disjoint
 * by the prefix rather than by assuming ids stay numeric.
 *
 * Only the *shape* is checked here. Whether the referenced key is actually declared
 * is `validateJourneyDeclaration`'s job, because it is the only thing holding the
 * whole journey and can therefore answer it.
 */
const permissionRoleIdSchema = z.string().min(1).refine(
    (roleId) => {
        const key = parseDeclaredRoleReference(roleId);
        return key === undefined || /^[a-z0-9]+(-[a-z0-9]+)*$/.test(key);
    },
    {
        message:
            'A declared role reference must name a valid resource key (lowercase letters, numbers and single hyphens).',
    }
);

const permissionIntentSchema = z
    .object({
        audience: z.enum(PERMISSION_AUDIENCES),
        roleIds: z.array(permissionRoleIdSchema).optional(),
        access: z.enum(PERMISSION_ACCESS_LEVELS),
    })
    // `roles` without role ids compiles to an error deep inside the applier at install
    // time. Rejecting it at save time blames the field the operator can actually fix.
    .refine((intent) => intent.audience !== 'roles' || (intent.roleIds?.length ?? 0) > 0, {
        message: 'A `roles` permission must name at least one role.',
        path: ['roleIds'],
    });

/**
 * A Discord snowflake, as the id of something being adopted.
 *
 * Shape-checked here and nowhere else in the request path. Whether the id names
 * anything real is a question only the guild can answer, and it is asked at plan
 * time (`buildInstallPlan`) and again at apply time (`requireAdoptable`) — a channel
 * can be deleted between declaring it and installing, so a save-time existence check
 * would be a guarantee that expires. What this *can* stop is a non-id reaching the
 * plan, where it would surface as "this channel does not exist" and send the operator
 * looking for a deletion that never happened.
 */
const discordIdSchema = z
    .string()
    .regex(/^\d{17,20}$/, 'A channel or role id is 17 to 20 digits.');

/**
 * Exported for the chip-agreement test, which drives this schema and
 * `validateJourneyDeclaration` with the same declarations the browser's
 * `detectResourceProblems` judges, and fails if the three disagree. Nothing else
 * should import it — the save path is the only caller.
 */
export const resourceSchema = z.object({
    key: resourceKeySchema,
    kind: z.enum(RESOURCE_KINDS),
    defaultName: z
        .string()
        .min(1, 'Give the resource a name.')
        .max(100, 'Resource names cap at 100 characters.'),
    parentKey: resourceKeySchema.optional(),
    permissions: z.array(permissionIntentSchema).optional(),
    description: z.string().max(500, 'Descriptions cap at 500 characters.').optional(),
    /** Set when the operator picked something that already exists instead of declaring a new one. */
    adoptDiscordId: discordIdSchema.optional(),
});

/**
 * Which drifted resources the operator ticked.
 *
 * Keys rather than the reviewed report, because the report is rebuilt server-side —
 * see the route. `min(1)` because an empty repair is a request that cannot have been
 * meant: the button is only reachable with something selected, so an empty array is a
 * malformed client rather than an operator who chose nothing, and silently returning
 * "repaired 0" would hide that.
 */
/**
 * A `resource_bindings` row id, as it appears in a path.
 *
 * Matched as **text** rather than coerced, because `Number` is lenient in ways a row id
 * is not: `Number('0x2a')` is 42, and so are `' 42 '`, `'4.2e1'` and `'42.0'` — while
 * `Number('')` is **0**, which `Number.isInteger` accepts. None of those could reach the
 * wrong row, since the orphan re-find is the real gate, and that was the problem: the
 * 400 was decorative and the whole protection rested on a downstream lookup. A validator
 * that accepts hex for a primary key is the wrong shape even where it is harmless.
 *
 * `max(16)` because the id is a `Generated<number>` and sixteen digits is already past
 * anything this table will hold — it stops a caller handing us a string long enough to
 * lose precision on the way to a `number`.
 */
const bindingIdSchema = z
    .string()
    .regex(/^\d{1,16}$/, 'A binding id is a whole number.')
    .refine((value) => Number(value) > 0, 'A binding id starts at 1.');

/**
 * Exported for the route test that asserts a forged `approvedPlan` is stripped here
 * rather than merely ignored downstream. That distinction is not observable through
 * the handler — see the test — so the schema is checked directly.
 */
export const repairBody = z.object({
    resourceKeys: z
        .array(resourceKeySchema)
        .min(1, 'Choose at least one resource to repair.'),
});

const createJourneyBody = z.object({
    journeyKey: resourceKeySchema,
    name: z.string().min(1, 'Give the journey a name.').max(100, 'Journey names cap at 100 characters.'),
    description: z.string().max(500, 'Descriptions cap at 500 characters.').optional(),
    resources: z.array(resourceSchema),
});

const updateJourneyBody = z.object({
    name: z.string().min(1, 'Give the journey a name.').max(100, 'Journey names cap at 100 characters.').optional(),
    description: z.string().max(500, 'Descriptions cap at 500 characters.').nullable().optional(),
    resources: z.array(resourceSchema).optional(),
});

/**
 * What the flows page sends when a row is dropped onto another.
 *
 * `resolution` has no default on purpose. Omitting it is only legal when the moving flow
 * declares nothing — the silent, common case — and any other omission is a 400 rather
 * than an assumed answer, because both outcomes are consequential and one of them
 * abandons live channels.
 *
 * The new journey's key is supplied by the client, which already derives a unique slug
 * for the attach modal. Validated here against the same shape every other key uses, so
 * a hand-rolled request cannot conjure one the rest of the system could not store.
 */
const groupFlowBody = z.object({
    targetFlowId: z.string().min(1, 'Name the flow being grouped with.'),
    resolution: z.enum(['merge', 'leave']).optional(),
    newJourneyKey: resourceKeySchema.optional(),
    newJourneyName: z
        .string()
        .min(1, 'Give the journey a name.')
        .max(100, 'Journey names cap at 100 characters.')
        .optional(),
});

function journeyDetail(journey: JourneyEntity) {
    return {
        journeyKey: journey.journeyKey,
        name: journey.name,
        description: journey.description,
        resources: journey.resources,
        createdAt: new Date(journey.createdAt).toISOString(),
        updatedAt: new Date(journey.updatedAt).toISOString(),
    };
}

/** A flow attached to a journey, as the list reports it. */
interface AttachedFlowSummary {
    flowId: string;
    name: string;
}

/**
 * The list shape: metadata, a count, and **which flows are attached**.
 *
 * The attachments are what make a journey legible as a shared thing rather than a row
 * with a key. They are also what an operator needs before pressing delete, since that is
 * refused while anything is attached — showing the names on the row means the refusal
 * confirms something already on screen rather than being the first they hear of it.
 */
function journeySummary(journey: JourneyEntity, attachedFlows: readonly AttachedFlowSummary[]) {
    return {
        journeyKey: journey.journeyKey,
        name: journey.name,
        description: journey.description,
        resourceCount: journey.resources.length,
        attachedFlows,
        createdAt: new Date(journey.createdAt).toISOString(),
        updatedAt: new Date(journey.updatedAt).toISOString(),
    };
}

export function journeyRoutes(): Hono<AppEnv> {
    const app = new Hono<AppEnv>();

    /**
     * Every journey in the guild, with the flows attached to each.
     *
     * **Three queries, not N+1.** The journeys, every link in the guild, and every flow
     * in the guild — then the join happens in memory. Asking
     * `listFlowIdsForJourney` per row and then a name per id is two nested loops of
     * queries over lists that both grow with the server, and it is the shape that looks
     * fine on a developer's three journeys.
     *
     * Flow names come from the guild's own flows, so a link pointing outside this guild
     * contributes no name — the same rule `flowNameInGuild` applies, kept here because
     * these names go in a response body.
     */
    app.get('/:guildId/journeys', async (c) => {
        const guildId = c.get('guild').id;
        const [journeys, links, flows] = await Promise.all([
            journeysRepo.listByGuildId(guildId),
            flowJourneyLinksRepo.listLinksForGuild(guildId),
            flowsRepo.getByGuildId(guildId),
        ]);

        const flowNames = new Map(flows.map((flow) => [flow.flowId, flow.name]));
        const attachedByKey = new Map<string, AttachedFlowSummary[]>();
        for (const link of links) {
            const forKey = attachedByKey.get(link.journeyKey) ?? [];
            // A flow whose row has vanished keeps its id as the label rather than being
            // dropped, matching `otherFlowsOnJourney`: a dangling link is still
            // something that blocks a delete, and hiding it here would make the refusal
            // name a flow the list never showed.
            forKey.push({ flowId: link.flowId, name: flowNames.get(link.flowId) ?? link.flowId });
            attachedByKey.set(link.journeyKey, forKey);
        }

        return c.json({
            journeys: journeys.map((journey) =>
                journeySummary(journey, attachedByKey.get(journey.journeyKey) ?? [])
            ),
        });
    });

    app.get('/:guildId/journeys/:journeyKey', async (c) => {
        const journey = await journeysRepo.getByKey(c.get('guild').id, c.req.param('journeyKey'));
        if (!journey) {
            return c.json({ error: 'Journey not found.' }, 404);
        }

        return c.json(journeyDetail(journey));
    });

    /**
     * What this **journey** has live in the guild.
     *
     * The group header's inventory. Distinct from
     * `GET /flows/:flowId/published` in the half that matters: the button messages of
     * every attached flow are here, because unpublishing the journey takes all of them
     * down. The page used to reach this information through its first member, which
     * showed one flow's buttons beside an action that would have removed its siblings'
     * too.
     *
     * `journeysRepo.getByKey` is guild-scoped, so a key belonging to another guild is a
     * 404 and never confirms that guild's journey exists. The check is also what makes
     * the empty state honest: without it a foreign key would plan against no bindings and
     * report "nothing installed" for a journey that is fully installed elsewhere.
     */
    app.get('/:guildId/journeys/:journeyKey/published', async (c) => {
        const guild = c.get('guild');
        const journeyKey = c.req.param('journeyKey');

        const journey = await journeysRepo.getByKey(guild.id, journeyKey);
        if (!journey) {
            return c.json({ error: 'Journey not found.' }, 404);
        }

        return c.json(publishedBody(await getPublishedJourneyState(guild, journeyKey)));
    });

    /**
     * Take every attached flow's trigger buttons back out of the guild.
     *
     * Fans out over the journey's attachments and undeploys each, which is the same
     * scope the inventory above reports — the dialog's "take buttons down" must remove
     * exactly what it just listed.
     *
     * Unlike `POST /flows/:flowId/undeploy`, this **does** require the journey to exist.
     * That route can run after its flow's row is gone because `flow_button_messages`
     * outlives the flow and its id is the only way back to those messages; here the
     * journey row is the only thing that names which flows to fan out to, so a missing
     * one leaves nothing to act on rather than a cleanup worth attempting.
     *
     * Results are flattened across flows and reported as one list. The operator asked
     * about the journey, and per-flow buckets would make them reassemble the answer.
     *
     * **Sequential, and a throw from one flow does not lose the others.**
     * `undeployFlowButtons` already loops message by message and carries on past a
     * failure, for the stated reason that buttons in one channel have nothing to do with
     * buttons in another. Fanning out with `Promise.all` would invert that guarantee one
     * level up: the first rejection discards every sibling's report, including deletions
     * that have already happened in Discord — and those rows are the only record of where
     * the remaining live buttons are. A flow that throws is reported as a failure against
     * itself and the run continues.
     */
    app.post('/:guildId/journeys/:journeyKey/undeploy', async (c) => {
        const guildId = c.get('guild').id;
        const journeyKey = c.req.param('journeyKey');

        const journey = await journeysRepo.getByKey(guildId, journeyKey);
        if (!journey) {
            return c.json({ error: 'Journey not found.' }, 404);
        }

        const flowIds = await flowJourneyLinksRepo.listFlowIdsForJourney(guildId, journeyKey);

        const results: UndeployedButtonMessage[] = [];
        for (const flowId of flowIds) {
            try {
                results.push(...(await undeployFlowButtons(guildId, flowId)).results);
            } catch (error) {
                // No channel or message id to name — the throw came from the lookup that
                // would have supplied them. The flow id is what the operator can act on,
                // and reporting nothing at all would make a failed flow look like one
                // with no buttons.
                results.push({
                    channelId: '',
                    messageId: '',
                    outcome: 'failed',
                    explanation: `Could not read the buttons for flow ${flowId}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                });
            }
        }

        return c.json({ results });
    });

    /**
     * Destroy the channels and roles this journey created.
     *
     * **The shared-journey 409 deliberately does not fire here, and must not.** That
     * refusal exists on `POST /flows/:flowId/unpublish` to stop one flow tearing down
     * structure its siblings still install — the operator is holding a flow and cannot
     * see the others. An operator acting on the *journey* is the legitimate case it was
     * protecting against: they are looking at the group, the dialog names every flow
     * affected, and there is no third party whose work is being destroyed behind their
     * back. Reproducing the guard here would make a shared journey impossible to
     * uninstall from the one screen that scopes the decision correctly.
     *
     * The plan is rebuilt server-side and applied, never accepted from the browser, for
     * the reason the flow route records: a plan arriving over the wire is a list of
     * snowflakes a client asked us to delete, and nothing would stop it naming objects
     * the real plan refuses.
     *
     * No ownership check either, and none is available — a journey has no single owning
     * flow once it is shared, which is precisely why `flowJourney`'s positive check
     * could not be reused. The guild scope is the boundary: `getByKey` proves the
     * journey is this guild's, and `requireGuildAccess` has already proved the caller
     * may act on this guild.
     */
    app.post('/:guildId/journeys/:journeyKey/unpublish', async (c) => {
        const guild = c.get('guild');
        const journeyKey = c.req.param('journeyKey');

        const journey = await journeysRepo.getByKey(guild.id, journeyKey);
        if (!journey) {
            return c.json({ error: 'Journey not found.' }, 404);
        }

        const plan = await previewUnpublish(guild, journeyKey);
        const result = await unpublishJourney({ guild, approvedPlan: plan });

        if (result.refusal) {
            return c.json({ error: result.refusal }, 409);
        }

        return c.json({ results: result.results });
    });

    /**
     * What this journey installed that no longer matches what it declares.
     *
     * The third question about a binding, after "does it exist" (the install plan) and
     * "may I delete it" (the inventory above). Until this route existed the engine
     * could answer it and no operator could ask — `buildInstallPlan` decides `reuse` on
     * existence alone, so a channel renamed, dragged out of its category and stripped
     * of its overwrites reported as a clean reuse forever.
     *
     * Orphans ride along in the same response rather than getting a route of their own.
     * They are a different question — a resource we installed and no longer declare, so
     * there is nothing to compare it against — but they are the *same screen*: an
     * operator asking "is my server still what I asked for" is owed both answers at
     * once, and two fetches would let the dialog show half an answer.
     *
     * Read-only, and it reads the guild rather than the binding table's opinion of it.
     * That is the whole difference between this and the `installState` on the flows
     * list, which is deliberately the weaker claim.
     */
    app.get('/:guildId/journeys/:journeyKey/drift', async (c) => {
        const guild = c.get('guild');
        const journeyKey = c.req.param('journeyKey');

        const row = await journeysRepo.getByKey(guild.id, journeyKey);
        if (!row) {
            return c.json({ error: 'Journey not found.' }, 404);
        }

        const journey = toDeclarationFromRow(row);
        // Read once and used for the comparison, so it compiles the same permission
        // models an install would — the reason `previewDrift` takes these at all.
        const staffRoleIds = await guildSettingsRepo.getStaffRoleIds(guild.id);

        const [plan, orphans] = await Promise.all([
            previewDrift({ guild, journey, staffRoleIds }),
            previewOrphans({ guild, journey }),
        ]);

        return c.json(driftBody(plan, orphans));
    });

    /**
     * Put approved drift back to what the journey declared.
     *
     * **The plan is rebuilt here and never accepted from the browser**, matching
     * `/install` and `/unpublish`. `repairDrift` takes an `approvedPlan` because the
     * applier must act on findings someone reviewed rather than ones it just invented,
     * but "reviewed" is satisfied by rebuilding and acting only on the keys the
     * operator ticked: a rebuild can only ever report *different* drift, and a key
     * whose drift has changed or resolved since the preview is then either repaired to
     * the declaration it was always heading for, or reported as nothing to do. What it
     * cannot do is act on a finding the browser made up, which is what accepting a plan
     * over the wire would permit.
     *
     * The adoption promise is re-derived from the binding rows inside `repairDrift`
     * regardless, so neither the keys nor the plan can talk us into touching structure
     * that predates the journey.
     *
     * A partial repair is **200, not an error**, for the same reason a partial install
     * is: what was fixed is really fixed, and the per-item results say where it stopped.
     */
    app.post('/:guildId/journeys/:journeyKey/repair', async (c) => {
        const guild = c.get('guild');
        const journeyKey = c.req.param('journeyKey');

        const row = await journeysRepo.getByKey(guild.id, journeyKey);
        if (!row) {
            return c.json({ error: 'Journey not found.' }, 404);
        }

        const parsed = repairBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body.' }, 400);
        }

        const journey = toDeclarationFromRow(row);
        // Re-read rather than carried from the preview, for the same reason the plan is
        // rebuilt: staff roles can change between reading a report and pressing repair.
        const staffRoleIds = await guildSettingsRepo.getStaffRoleIds(guild.id);
        const plan = await previewDrift({ guild, journey, staffRoleIds });

        const result = await repairDrift({
            guild,
            journey,
            staffRoleIds,
            approvedPlan: plan,
            approvedKeys: new Set(parsed.data.resourceKeys),
        });

        if (result.refusal) {
            return c.json({ error: result.refusal }, 409);
        }

        return c.json({ results: result.results });
    });

    /**
     * Drop the record of a resource this journey no longer declares.
     *
     * **Forgets the row; never touches the object.** The two are genuinely separable
     * and only one of them is safe to offer here: deleting a stray channel needs the
     * cascade and adoption guards `buildUnpublishPlan` spent a slice getting right, and
     * a second delete path that reimplemented them slightly differently is exactly the
     * duplicate-approach the repo's rules forbid. An operator who wants the object gone
     * tears the journey down, or deletes it in Discord.
     *
     * So this is the cleanup for the *leftover record* — the thing an operator cannot
     * see or reach any other way, and which otherwise makes the object invisible and
     * permanent. The object it referred to, if it is still there, is left exactly where
     * it is and the response says so.
     *
     * Scoped to this journey's own bindings. A binding id belonging to another journey
     * — or another guild — is a 404, so an id guessed at a URL cannot drop a row the
     * operator was never shown.
     */
    app.post('/:guildId/journeys/:journeyKey/orphans/:bindingId/forget', async (c) => {
        const guild = c.get('guild');
        const journeyKey = c.req.param('journeyKey');

        const row = await journeysRepo.getByKey(guild.id, journeyKey);
        if (!row) {
            return c.json({ error: 'Journey not found.' }, 404);
        }

        const parsedId = bindingIdSchema.safeParse(c.req.param('bindingId'));
        if (!parsedId.success) {
            return c.json({ error: 'Binding id must be a whole number.' }, 400);
        }
        const bindingId = Number(parsedId.data);

        /*
         * Re-found through `previewOrphans` rather than forgotten by id directly.
         *
         * The id alone would let this drop a binding that is still declared — the one
         * row whose disappearance genuinely breaks things, because install would then
         * create a *second* copy of a resource that already exists. Requiring it to
         * still be an orphan means the only rows reachable here are ones nothing
         * references, and it closes the window where an operator re-adds the resource
         * in another tab between reading the report and pressing forget.
         */
        const journey = toDeclarationFromRow(row);
        const orphans = await previewOrphans({ guild, journey });
        const orphan = orphans.find((entry) => entry.bindingId === bindingId);

        if (!orphan) {
            return c.json(
                {
                    error: 'That leftover record is not there any more — it may already have been removed, or the resource has been declared again. Reopen the report to see what is true now.',
                },
                404
            );
        }

        const forgotten = await resourceBindingsRepo.forget(bindingId);
        if (!forgotten) {
            return c.json({ error: 'That leftover record was already removed.' }, 404);
        }

        return c.json({
            forgotten: true,
            resourceKey: orphan.resourceKey,
            name: orphan.name,
            // The operator is owed the distinction: a row dropped behind a live object
            // means something is still sitting in their server that nothing tracks any
            // more, and that is the case where they may want to go and look at it.
            objectRemains: orphan.stillInGuild,
        });
    });

    /**
     * The resources one flow declares.
     *
     * A flow's journey starts **implicit**: created on first save and keyed on the
     * flow's own id, so an operator never invents a name for a concept they did not
     * ask for. Which journey that is now comes from the flow's attachment, so a flow
     * sharing a journey reads the resources that journey declares rather than looking
     * for one keyed with its own id and finding nothing.
     *
     * Returns an empty list rather than a 404 when the flow has declared nothing —
     * "no resources yet" is the normal state of every flow, not an error.
     */
    app.get('/:guildId/flows/:flowId/resources', async (c) => {
        const resolved = await resolveFlowJourney(c.get('guild').id, c.req.param('flowId'));
        return c.json({ resources: resolved?.journey.resources ?? [] });
    });

    /**
     * Replace what a flow declares, creating its journey on first use.
     *
     * A full replace rather than a patch: the panel edits a list, and a partial
     * update would make "I deleted a row" indistinguishable from "I didn't mention
     * it". The journey is created on the first save with a non-empty list, which is
     * what "journeys are created implicitly with a flow" means in practice.
     */
    app.put('/:guildId/flows/:flowId/resources', async (c) => {
        const guildId = c.get('guild').id;
        const flowId = c.req.param('flowId');

        const parsed = z
            .object({ resources: z.array(resourceSchema) })
            .safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body.' }, 400);
        }

        const flow = await flowsRepo.getByFlowId(flowId);
        if (!flow || flow.guildId !== guildId) {
            return c.json({ error: 'Flow not found.' }, 404);
        }

        const resolved = await resolveFlowJourney(guildId, flowId);

        // Only a journey this flow alone holds may be rewritten from here. Whether it
        // is shared is asked of the **link table**, not of whether the key happens to
        // equal the flow id: that comparison is right only while a journey holds one
        // flow, so it would quietly stop being right exactly when sharing is used —
        // and in both directions, refusing a flow alone on a named journey while
        // letting a flow clear its own implicit journey out from under a second one
        // attached to it.
        //
        // Checked for the save too, not only the clear: `journeysRepo.update` replaces
        // `resources` wholesale, so dropping four of five resources is the same damage
        // as clearing them.
        const shared = resolved
            ? await otherFlowsOnJourney(guildId, resolved.journey.journeyKey, flowId, {
                  flowName: (id) => flowNameInGuild(guildId, id),
              })
            : [];

        // An empty list means the flow declares nothing, which is not an empty
        // journey but *no* journey — `validateJourneyDeclaration` rejects a journey
        // with no resources, correctly, since installing one would do nothing.
        //
        // The journey row goes; `resource_bindings` deliberately stay, because they
        // record channels that exist in the guild and removing them would orphan real
        // Discord objects. Tearing those down is uninstall's job.
        if (parsed.data.resources.length === 0) {
            if (shared.length > 0) {
                return c.json(
                    {
                        error: sharedJourneyRefusal({
                            journeyName: resolved?.journey.name ?? flowId,
                            action: 'Clearing the resources on the journey',
                            others: shared,
                        }),
                    },
                    409
                );
            }

            // Detached **before** the journey is deleted, and the order is load-bearing:
            // a link naming a journey that no longer exists resolves to nothing, which
            // would leave the flow unable to install or unpublish while its channels
            // stand in the guild. Failing the other way round merely leaves a link to a
            // journey that still exists, which the next save converges.
            await flowJourneyLinksRepo.detachFlow(guildId, flowId);
            // The **resolved** key, not the flow id. A flow alone on a journey keyed
            // otherwise — the case slice A exists to enable — would otherwise delete
            // nothing, detach itself, and report success, leaving the journey row
            // behind attached to nobody.
            await journeysRepo.deleteByKey(guildId, resolved?.journey.journeyKey ?? flowId);
            return c.json({ resources: [] });
        }

        if (shared.length > 0) {
            return c.json(
                {
                    error: sharedJourneyRefusal({
                        journeyName: resolved?.journey.name ?? flowId,
                        action: 'Replacing the resources on the journey',
                        others: shared,
                    }),
                },
                409
            );
        }

        try {
            const journey = resolved
                ? await journeysRepo.update(guildId, resolved.journey.journeyKey, {
                      resources: parsed.data.resources,
                  })
                : await journeysRepo.create({
                      guildId,
                      // The flow's id, so the scope is unambiguous and needs no name.
                      journeyKey: flowId,
                      // Named after the flow for diagnostics only. The key is identity.
                      name: flow.name,
                      resources: parsed.data.resources,
                      createdForFlowId: flowId,
                  });

            // Written on every save, not only on create: an implicit journey is
            // explicit from birth, and a flow whose journey predates the link table
            // gets its row the first time it is saved. The upsert makes the repeat
            // case a no-op, so this costs one idempotent write rather than a branch
            // that has to know which case it is in.
            await flowJourneyLinksRepo.attach({
                guildId,
                flowId,
                journeyKey: journey.journeyKey,
            });

            return c.json({ resources: journey.resources });
        } catch (error) {
            return errorResponse(c, error);
        }
    });

    /**
     * Which journey this flow is attached to, if any.
     *
     * The builder reads this to decide whether to offer "attach" or "detach", and it
     * reports the **resolved** attachment rather than only a link row — a flow still on
     * the pre-link fallback is genuinely attached to its implicit journey, and telling
     * the operator it is attached to nothing would offer them an attach that silently
     * moves what they already have.
     *
     * `sharedWith` names the other flows on the same journey, because "detach" reads
     * very differently depending on whether anything else is holding it.
     */
    app.get('/:guildId/flows/:flowId/attachment', async (c) => {
        const guildId = c.get('guild').id;
        const flowId = c.req.param('flowId');

        const flow = await flowsRepo.getByFlowId(flowId);
        if (!flow || flow.guildId !== guildId) {
            return c.json({ error: 'Flow not found.' }, 404);
        }

        const resolved = await resolveFlowJourney(guildId, flowId);
        if (!resolved) {
            return c.json({ attachment: null });
        }

        const others = await otherFlowsOnJourney(guildId, resolved.journey.journeyKey, flowId, {
            flowName: (otherFlowId) => flowNameInGuild(guildId, otherFlowId),
        });

        return c.json({
            attachment: {
                journeyKey: resolved.journey.journeyKey,
                name: resolved.journey.name,
                resourceCount: resolved.journey.resources.length,
                sharedWith: others.map((other) => ({ flowId: other.flowId, name: other.label })),
            },
        });
    });

    /**
     * Attach a flow to an existing journey.
     *
     * **This route is the trust boundary for `flowJourney()`'s ownership check.** That
     * guard treats a link row as positive evidence that a flow may install a journey —
     * it creates channels and roles, so attributing them to a flow that never declared
     * them is the failure it exists to prevent. Before this route existed, the only
     * writer of a link row was the flow's own resource-panel save, which made the
     * evidence self-evidently the flow's own. Now that an operator supplies the key, two
     * things keep the row just as strong, and both are checked here rather than assumed
     * downstream:
     *
     *  - **the flow is in this guild**, and
     *  - **the journey already exists in this guild**, so a key cannot be conjured and
     *    an attachment cannot name a row the operator has never seen.
     *
     * A key naming nothing is a 404 rather than a created-on-demand journey. Creating
     * one here would reintroduce exactly the hazard the guard describes: a typed key
     * becoming an installable journey with no declaration behind it.
     *
     * **Attaching is a move, not an addition.** The unique index on `(guildId, flowId)`
     * says a flow has at most one journey, so attaching an already-attached flow detaches
     * it from the old one in the same statement. The response reports `movedFrom` so the
     * UI can say which journey was left rather than implying a flow now has two.
     */
    app.post('/:guildId/flows/:flowId/attach', async (c) => {
        const guildId = c.get('guild').id;
        const flowId = c.req.param('flowId');

        const parsed = z
            .object({ journeyKey: resourceKeySchema })
            .safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body.' }, 400);
        }

        // Guild-scoped, and a mismatch is a 404 rather than a 403: never confirm another
        // guild's flow exists. `flowsRepo.getByFlowId` matches on the id alone, so this
        // check is the route's job.
        const flow = await flowsRepo.getByFlowId(flowId);
        if (!flow || flow.guildId !== guildId) {
            return c.json({ error: 'Flow not found.' }, 404);
        }

        const journey = await journeysRepo.getByKey(guildId, parsed.data.journeyKey);
        if (!journey) {
            return c.json({ error: 'Journey not found.' }, 404);
        }

        // Read before the write, so the response can name what the flow is leaving. A
        // no-op re-attach resolves to the same journey and reports no move.
        const current = await resolveFlowJourney(guildId, flowId);
        const movedFrom =
            current && current.journey.journeyKey !== journey.journeyKey
                ? { journeyKey: current.journey.journeyKey, name: current.journey.name }
                : null;

        await flowJourneyLinksRepo.attach({ guildId, flowId, journeyKey: journey.journeyKey });

        return c.json({
            journeyKey: journey.journeyKey,
            name: journey.name,
            resourceCount: journey.resources.length,
            movedFrom,
        });
    });

    /**
     * Detach a flow from whatever journey it is on.
     *
     * **Deliberately leaves `resource_bindings` alone.** Those rows name channels and
     * roles that exist in the guild; dropping them because a flow walked away would
     * orphan real Discord objects with nothing left that knows we created them. Tearing
     * them down is `/unpublish`'s job and an operator has to ask for it — which is the
     * same "offer, never assume" rule that deleting a flow follows.
     *
     * The journey row stays too, for the same reason and one more: other flows may still
     * be attached to it, and this route has no business deciding that a journey is
     * finished because one flow left.
     */
    app.post('/:guildId/flows/:flowId/detach', async (c) => {
        const guildId = c.get('guild').id;
        const flowId = c.req.param('flowId');

        const flow = await flowsRepo.getByFlowId(flowId);
        if (!flow || flow.guildId !== guildId) {
            return c.json({ error: 'Flow not found.' }, 404);
        }

        const detached = await flowJourneyLinksRepo.detachFlow(guildId, flowId);

        // 200 either way. "Already detached" is the state the caller asked for, and a
        // 404 would make the UI report a failure for reaching the outcome it wanted.
        return c.json({ detached });
    });

    /**
     * What grouping this flow with that one would do, before anything is written.
     *
     * The flows page calls this on drop and shows the answer. It exists as its own route
     * rather than as a field on the group call because the operator has a real choice to
     * make — merge the resources or leave them — and a dialog cannot offer a choice it
     * has to perform first to describe.
     *
     * `target` is the *other* flow in the gesture: the row that was dropped on. Its
     * journey is the destination, creating one if it has none, so this route answers for
     * the journey that would exist rather than the one that does.
     */
    app.get('/:guildId/flows/:flowId/group-preview', async (c) => {
        const guildId = c.get('guild').id;
        const flowId = c.req.param('flowId');
        const targetFlowId = c.req.query('target');

        if (!targetFlowId) {
            return c.json({ error: 'Name the flow being grouped with.' }, 400);
        }
        if (targetFlowId === flowId) {
            return c.json({ error: 'A flow cannot be grouped with itself.' }, 400);
        }

        const [flow, target] = await Promise.all([
            flowsRepo.getByFlowId(flowId),
            flowsRepo.getByFlowId(targetFlowId),
        ]);
        if (!flow || flow.guildId !== guildId) {
            return c.json({ error: 'Flow not found.' }, 404);
        }
        if (!target || target.guildId !== guildId) {
            return c.json({ error: 'Flow not found.' }, 404);
        }

        const [moving, destination] = await Promise.all([
            resolveFlowJourney(guildId, flowId),
            resolveFlowJourney(guildId, targetFlowId),
        ]);

        // A journey holding more than one flow cannot follow one of them away: the
        // others still install it. Refused here rather than in `planJourneyMerge`,
        // which is pure and has no way to ask who else is attached.
        if (moving) {
            const others = await otherFlowsOnJourney(guildId, moving.journey.journeyKey, flowId, {
                flowName: (otherFlowId) => flowNameInGuild(guildId, otherFlowId),
            });
            if (others.length > 0) {
                return c.json(
                    {
                        error: sharedJourneyRefusal({
                            journeyName: moving.journey.name,
                            action: 'Moving this flow out of',
                            others,
                        }),
                    },
                    409
                );
            }
        }

        const bindings = moving
            ? await resourceBindingsRepo.listByJourney(guildId, moving.journey.journeyKey)
            : [];

        const plan = planJourneyMerge({
            movingDeclarations: moving?.journey.resources ?? [],
            destinationDeclarations: destination?.journey.resources ?? [],
            movingBindings: bindings,
        });

        return c.json({
            /** Null when the target has no journey yet — one would be created. */
            destination: destination
                ? { journeyKey: destination.journey.journeyKey, name: destination.journey.name }
                : null,
            destinationName: destination?.journey.name ?? target.name,
            movingFlowName: flow.name,
            ...plan,
        });
    });

    /**
     * Group one flow with another: the drop, committed.
     *
     * One route rather than the client orchestrating create-then-attach, because those
     * two writes have to agree. A crash between them leaves a journey nothing is
     * attached to — the exact state `resolveFlowJourney`'s fallback exists to paper
     * over, and the state slice E cannot delete the fallback until nothing produces.
     *
     * `resolution` is the operator's answer to the preview, and is required whenever
     * the moving flow has resources of its own. Defaulting it would make the destructive
     * choice the quiet one.
     */
    app.post('/:guildId/flows/:flowId/group', async (c) => {
        const guildId = c.get('guild').id;
        const flowId = c.req.param('flowId');

        const parsed = groupFlowBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body.' }, 400);
        }
        const { targetFlowId, resolution, newJourneyKey, newJourneyName } = parsed.data;

        if (targetFlowId === flowId) {
            return c.json({ error: 'A flow cannot be grouped with itself.' }, 400);
        }

        const [flow, target] = await Promise.all([
            flowsRepo.getByFlowId(flowId),
            flowsRepo.getByFlowId(targetFlowId),
        ]);
        if (!flow || flow.guildId !== guildId) {
            return c.json({ error: 'Flow not found.' }, 404);
        }
        if (!target || target.guildId !== guildId) {
            return c.json({ error: 'Flow not found.' }, 404);
        }

        const [moving, destination] = await Promise.all([
            resolveFlowJourney(guildId, flowId),
            resolveFlowJourney(guildId, targetFlowId),
        ]);

        // Same refusal as the preview. Re-checked rather than trusted from it: the
        // preview is a separate request and anything could have attached in between.
        if (moving) {
            const others = await otherFlowsOnJourney(guildId, moving.journey.journeyKey, flowId, {
                flowName: (otherFlowId) => flowNameInGuild(guildId, otherFlowId),
            });
            if (others.length > 0) {
                return c.json(
                    {
                        error: sharedJourneyRefusal({
                            journeyName: moving.journey.name,
                            action: 'Moving this flow out of',
                            others,
                        }),
                    },
                    409
                );
            }
        }

        const movingResources = moving?.journey.resources ?? [];
        if (movingResources.length > 0 && !resolution) {
            return c.json(
                { error: 'This flow declares resources; say whether to merge them or leave them.' },
                400
            );
        }

        try {
            // The destination journey, created on demand when the target flow has none.
            // Named after the target flow, matching how an implicit journey is named at
            // `PUT /resources` — the key is identity, the name is for diagnostics.
            let destinationJourney = destination?.journey;
            if (!destinationJourney) {
                if (!newJourneyKey) {
                    return c.json({ error: 'A new group needs a key.' }, 400);
                }
                destinationJourney = await journeysRepo.create({
                    guildId,
                    journeyKey: newJourneyKey,
                    name: newJourneyName ?? target.name,
                    resources: [],
                });
                await flowJourneyLinksRepo.attach({
                    guildId,
                    flowId: targetFlowId,
                    journeyKey: destinationJourney.journeyKey,
                });
            }

            if (resolution === 'merge' && movingResources.length > 0) {
                const plan = planJourneyMerge({
                    movingDeclarations: movingResources,
                    destinationDeclarations: destinationJourney.resources,
                    movingBindings: [],
                });
                // Re-checked for the same reason as the shared-journey guard above, and
                // because this is the write that would make a colliding key permanent.
                if (!plan.canMerge) {
                    return c.json(
                        {
                            error: `Both journeys declare ${plan.collisions
                                .map((collision) => `**${collision.key}**`)
                                .join(', ')}. Rename one side before grouping.`,
                        },
                        409
                    );
                }

                destinationJourney = await journeysRepo.update(
                    guildId,
                    destinationJourney.journeyKey,
                    { resources: [...destinationJourney.resources, ...movingResources] }
                );

                /*
                 * A merge is a **move**, so the source is emptied once the copy lands.
                 *
                 * Leaving it populated shipped and was caught in live testing: the source
                 * row survives, and `/detach` only deletes a link, so
                 * `resolveFlowJourney`'s `journeyKey === flowId` fallback resurrects the
                 * old journey with its copies still in it. Group then ungroup left one
                 * category declared by two journeys, both naming one real Discord object
                 * — and no later question about who owns it has a single answer.
                 *
                 * The row itself stays. Its `resource_bindings` still name live objects
                 * and deleting the row they hang off would strand them, which is the rule
                 * `deleteByKey` and `/detach` already follow. Emptying the declarations
                 * is the part that makes the move a move; the bindings are unpublish's
                 * business, and the merge dialog already told the operator which of them
                 * it was bringing along.
                 */
                if (moving) {
                    await journeysRepo.update(guildId, moving.journey.journeyKey, {
                        resources: [],
                    });
                }
            }

            await flowJourneyLinksRepo.attach({
                guildId,
                flowId,
                journeyKey: destinationJourney.journeyKey,
            });

            return c.json({
                journeyKey: destinationJourney.journeyKey,
                name: destinationJourney.name,
                resourceCount: destinationJourney.resources.length,
            });
        } catch (error) {
            return errorResponse(c, error);
        }
    });

    app.post('/:guildId/journeys', async (c) => {
        const parsed = createJourneyBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body.' }, 400);
        }

        try {
            const journey = await journeysRepo.create({
                guildId: c.get('guild').id,
                journeyKey: parsed.data.journeyKey,
                name: parsed.data.name,
                description: parsed.data.description,
                resources: parsed.data.resources,
            });
            return c.json(journeyDetail(journey), 201);
        } catch (error) {
            return errorResponse(c, error);
        }
    });

    app.put('/:guildId/journeys/:journeyKey', async (c) => {
        const guildId = c.get('guild').id;
        const journeyKey = c.req.param('journeyKey');
        const existing = await journeysRepo.getByKey(guildId, journeyKey);
        if (!existing) {
            return c.json({ error: 'Journey not found.' }, 404);
        }

        const parsed = updateJourneyBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body.' }, 400);
        }

        try {
            const journey = await journeysRepo.update(guildId, journeyKey, {
                name: parsed.data.name,
                description: parsed.data.description,
                resources: parsed.data.resources,
            });
            return c.json(journeyDetail(journey));
        } catch (error) {
            return errorResponse(c, error);
        }
    });

    /**
     * Delete a journey, unless flows still depend on it.
     *
     * Deleting a journey that flows are attached to would orphan them: their link rows
     * would name a journey that no longer exists, and `resolveFlowJourney` returns
     * nothing for that rather than quietly falling back — so each flow would report
     * that it declares no resources while its installed channels stand in the guild.
     *
     * The refusal **names every attached flow** rather than counting them. A count
     * tells an operator the size of a problem they then have to go find; the names are
     * what they act on, and it is the shape the category-cascade refusal in
     * `buildUnpublishPlan` already uses.
     */
    app.delete('/:guildId/journeys/:journeyKey', async (c) => {
        const guildId = c.get('guild').id;
        const journeyKey = c.req.param('journeyKey');
        const existing = await journeysRepo.getByKey(guildId, journeyKey);
        if (!existing) {
            return c.json({ error: 'Journey not found.' }, 404);
        }

        // No flow is exempt here: unlike the flow-scoped routes, nothing is "the flow
        // asking", so every attachment counts against the delete.
        const attached = await otherFlowsOnJourney(guildId, journeyKey, null, {
            flowName: (flowId) => flowNameInGuild(guildId, flowId),
        });
        if (attached.length > 0) {
            return c.json(
                {
                    error: sharedJourneyRefusal({
                        journeyName: existing.name,
                        action: 'Deleting the journey',
                        others: attached,
                    }),
                },
                409
            );
        }

        await journeysRepo.deleteByKey(guildId, journeyKey);
        return c.body(null, 204);
    });

    return app;
}

/**
 * Map a repo error onto a status the builder can act on.
 *
 * Both cases are the operator's input being wrong, not the server failing, so
 * letting them fall through to a 500 would tell the builder nothing it could show.
 * Anything else is genuinely unexpected and is rethrown for the error handler.
 */
function errorResponse(c: Context<AppEnv>, error: unknown): Response {
    if (error instanceof DuplicateJourneyKeyError) {
        return c.json({ error: 'A journey with that key already exists in this server.' }, 409);
    }
    if (error instanceof ResourceDeclarationError) {
        return c.json({ error: error.message }, 400);
    }
    throw error;
}
