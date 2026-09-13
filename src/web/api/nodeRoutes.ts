import { Hono } from 'hono';
import { listBlockDefinitions } from '../../features/flows/blocks/registry';
import type { AppEnv } from '../types';

/**
 * The block catalogue that drives the builder's palette. Not guild-scoped — the
 * registry is process-wide — but still behind {@link requireAuth}.
 *
 * The registry is populated by `initFlows` before the web server starts, so this
 * route always sees every block. If that boot order is ever broken the lookup
 * raises rather than serving an empty palette.
 *
 * Only the display descriptor is exposed. `configSchema` is a Zod schema and is
 * deliberately not serialized: the builder hand-builds a form per node type
 * (design doc §5.5), so the schema stays server-authoritative.
 */
export function nodeRoutes(): Hono<AppEnv> {
    const app = new Hono<AppEnv>();

    app.get('/', (c) => {
        const nodes = listBlockDefinitions().map((definition) => ({
            type: definition.type,
            kind: definition.kind,
            label: definition.label,
        }));
        return c.json({ nodes });
    });

    return app;
}
