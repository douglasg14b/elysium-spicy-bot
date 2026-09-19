import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { DuplicateJourneyKeyError, journeysRepo } from '../../features/provisioning/data/journeysRepo';
import type { JourneyEntity } from '../../features/provisioning/data/journeysSchema';
import {
    PERMISSION_ACCESS_LEVELS,
    PERMISSION_AUDIENCES,
} from '../../features/provisioning/logic/permissionIntent';
import {
    RESOURCE_KINDS,
    ResourceDeclarationError,
} from '../../features/provisioning/logic/resourceDeclaration';
import type { AppEnv } from '../types';

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

const permissionIntentSchema = z
    .object({
        audience: z.enum(PERMISSION_AUDIENCES),
        roleIds: z.array(z.string().min(1)).optional(),
        access: z.enum(PERMISSION_ACCESS_LEVELS),
    })
    // `roles` without role ids compiles to an error deep inside the applier at install
    // time. Rejecting it at save time blames the field the operator can actually fix.
    .refine((intent) => intent.audience !== 'roles' || (intent.roleIds?.length ?? 0) > 0, {
        message: 'A `roles` permission must name at least one role.',
        path: ['roleIds'],
    });

const resourceSchema = z.object({
    key: resourceKeySchema,
    kind: z.enum(RESOURCE_KINDS),
    defaultName: z
        .string()
        .min(1, 'Give the resource a name.')
        .max(100, 'Resource names cap at 100 characters.'),
    parentKey: resourceKeySchema.optional(),
    permissions: z.array(permissionIntentSchema).optional(),
    description: z.string().max(500, 'Descriptions cap at 500 characters.').optional(),
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

/** The list shape: metadata plus a count, no resource bodies. */
function journeySummary(journey: JourneyEntity) {
    return {
        journeyKey: journey.journeyKey,
        name: journey.name,
        description: journey.description,
        resourceCount: journey.resources.length,
        createdAt: new Date(journey.createdAt).toISOString(),
        updatedAt: new Date(journey.updatedAt).toISOString(),
    };
}

export function journeyRoutes(): Hono<AppEnv> {
    const app = new Hono<AppEnv>();

    app.get('/:guildId/journeys', async (c) => {
        const journeys = await journeysRepo.listByGuildId(c.get('guild').id);
        return c.json({ journeys: journeys.map(journeySummary) });
    });

    app.get('/:guildId/journeys/:journeyKey', async (c) => {
        const journey = await journeysRepo.getByKey(c.get('guild').id, c.req.param('journeyKey'));
        if (!journey) {
            return c.json({ error: 'Journey not found.' }, 404);
        }

        return c.json(journeyDetail(journey));
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

    app.delete('/:guildId/journeys/:journeyKey', async (c) => {
        const guildId = c.get('guild').id;
        const journeyKey = c.req.param('journeyKey');
        const existing = await journeysRepo.getByKey(guildId, journeyKey);
        if (!existing) {
            return c.json({ error: 'Journey not found.' }, 404);
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
