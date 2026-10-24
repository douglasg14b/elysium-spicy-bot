import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { migrateTestDatabase } from '../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import { registerUploadUsageReader } from '../../features-system/guild-uploads';
import { ensureBlocksDiscovered } from '../../features/flows/blocks/registry';
import { flowUploadUses } from '../../features/flows/logic/flowUploadUses';
import { MIB } from '../../shared/byteSizes';
import { buildOpenApiDocument } from '../api/openApiDocument';
import { UPLOAD_CACHE_CONTROL, UPLOAD_NOT_AN_IMAGE_SENTENCE } from '../api/uploadRoutes';
import type { GuildUploadBody } from '../api/uploadBody';
import { buildApp } from '../server';
import type { AppEnv } from '../types';

/**
 * The upload routes as the whole app serves them — body cap, session, guild access and the
 * cache header guard all in front — on an in-memory SQLite built by the real migrations.
 *
 * The session and guild checks are the only stand-ins: every request is signed in and may
 * manage the guild it names. That is what lets a request *reach* the upload handler, which is
 * the point here. The body-cap tests in `buildApp.test.ts` are answered by middleware in front
 * of every guild path, so they would stay green if the upload route moved and its picked cap
 * stopped matching it; these follow the route by its operation id.
 */

vi.mock('../auth/middleware', async (importOriginal) => {
    const original = await importOriginal<typeof import('../auth/middleware')>();
    const { createMiddleware } = await import('hono/factory');
    return {
        ...original,
        requireAuth: createMiddleware<AppEnv>(async (c, next) => {
            c.set('user', { id: 'user-operator', username: 'operator', avatar: null, manageableGuildIds: [] });
            await next();
        }),
        requireGuildAccess: createMiddleware<AppEnv>(async (c, next) => {
            c.set('guild', { id: c.req.param('guildId') } as never);
            await next();
        }),
    };
});

const GUILD_ID = '900000000000000001';

/** The served path of the operation `operationId`, its `{guildId}` filled in. */
async function servedPath(operationId: string, params: Record<string, string> = {}): Promise<string> {
    const paths = (await buildOpenApiDocument()).paths ?? {};
    for (const [path, item] of Object.entries(paths)) {
        const operations = Object.values(item as Record<string, { operationId?: string } | undefined>);
        if (operations.some((operation) => operation?.operationId === operationId)) {
            return path.replace(/\{([^}]+)\}/g, (_match, name: string) => ({ guildId: GUILD_ID, ...params })[name] ?? '');
        }
    }
    throw new Error(`No operation ${operationId} in the spec.`);
}

/** `bytes` as a raw upload that declares its length, as a browser's does. */
function rawUpload(bytes: Uint8Array): RequestInit {
    return {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) },
        body: bytes,
    };
}

beforeAll(async () => {
    await ensureBlocksDiscovered();
    await migrateTestDatabase();
    // As `initFlows` does: the list asks what uses each picture, and fails with no reader.
    registerUploadUsageReader(flowUploadUses);
});

describe('the upload route as served', () => {
    it('takes a body over 1 MiB at the path the spec gives uploadGuildImage, through to the handler', async () => {
        // Not a picture, so the handler answers 415 — which only the handler can say. Were the
        // route's path and the picked cap to drift apart, the 1 MiB cap would answer 413 first.
        const response = await buildApp().request(await servedPath('uploadGuildImage'), rawUpload(new Uint8Array(2 * MIB)));

        expect(response.status).toBe(415);
        expect(await response.json()).toEqual({ error: UPLOAD_NOT_AN_IMAGE_SENTENCE });
    });
});

describe('caching an uploaded picture', () => {
    it('lets the browser keep a picture, and keeps every other answer uncacheable', async () => {
        const app = buildApp();
        const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(256)]);
        const created = await app.request(`${await servedPath('uploadGuildImage')}?name=cat.png`, rawUpload(png));
        const { uploadId } = (await created.json()) as GuildUploadBody;

        const picture = await app.request(await servedPath('getGuildUpload', { uploadId }));
        const missing = await app.request(await servedPath('getGuildUpload', { uploadId: 'no-such-upload' }));
        const list = await app.request(await servedPath('listGuildUploads'));

        expect(created.status).toBe(201);
        expect(created.headers.get('Cache-Control')).toBe('private, no-store');
        expect(picture.status).toBe(200);
        expect(picture.headers.get('Cache-Control')).toBe(UPLOAD_CACHE_CONTROL);
        expect(missing.status).toBe(404);
        expect(missing.headers.get('Cache-Control')).toBe('private, no-store');
        expect(list.status).toBe(200);
        expect(list.headers.get('Cache-Control')).toBe('private, no-store');
    });
});
