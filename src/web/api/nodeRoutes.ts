import { Hono } from 'hono';
import { listNodeDefinitions } from '../../features/flows/nodes/registry';
import type { AppEnv } from '../types';

/**
 * The node catalogue that drives the builder's palette. Not guild-scoped — the
 * registry is process-wide — but still behind {@link requireAuth}.
 *
 * Only the display descriptor is exposed. `configSchema` is a Zod schema and is
 * deliberately not serialized: the builder hand-builds a form per node type
 * (design doc §5.5), so the schema stays server-authoritative.
 */
export function nodeRoutes(): Hono<AppEnv> {
    const app = new Hono<AppEnv>();

    app.get('/', (c) => {
        const nodes = listNodeDefinitions().map((definition) => ({
            type: definition.type,
            kind: definition.kind,
            label: definition.label,
        }));
        return c.json({ nodes });
    });

    return app;
}
