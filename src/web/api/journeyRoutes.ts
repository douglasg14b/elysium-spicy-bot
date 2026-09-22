import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { flowsRepo } from '../../features/flows/data/flowsRepo';
import { flowJourneyLinksRepo } from '../../features/provisioning/data/flowJourneyLinksRepo';
import { DuplicateJourneyKeyError, journeysRepo } from '../../features/provisioning/data/journeysRepo';
import type { JourneyEntity } from '../../features/provisioning/data/journeysSchema';
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
import type { AppEnv } from '../types';
import { flowNameInGuild } from './flowNameInGuild';

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
