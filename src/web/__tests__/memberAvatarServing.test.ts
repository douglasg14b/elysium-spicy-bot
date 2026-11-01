import { randomBytes } from 'node:crypto';
import type { MemberName } from '@brattybot/web-sdk';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { migrateTestDatabase } from '../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import { memberAvatarsRepo } from '../../features-system/member-names';
import { memberNamesRepo, type SeenMember } from '../../features-system/member-names/data/memberNamesRepo';
import { ensureBlocksDiscovered } from '../../features/flows/blocks/registry';
import { MEMBER_AVATAR_NOT_FOUND_SENTENCE } from '../api/memberNameRoutes';
import { buildOpenApiDocument } from '../api/openApiDocument';
import { PICTURE_CACHE_CONTROL } from '../edgeGuards';
import { buildApp } from '../server';
import type { AppEnv } from '../types';

/**
 * A member's kept avatar as the whole app serves it — session, guild access and the cache
 * header guard in front — on an in-memory SQLite built by the real migrations, so the guild
 * scoping is the real join and not a mock's word for it.
 *
 * The session and guild checks are the only stand-ins, as in `uploadServing.test.ts`: every
 * request is signed in and may manage the guild it names. Every id asked about is already
 * recorded, so the names route asks Discord nothing.
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
const OTHER_GUILD_ID = '900000000000000002';
/** Recorded in this guild, picture kept. */
const KITTEN_ID = '400000000000000001';
/** Recorded in this guild, picture kept, but has since removed their avatar. */
const BARE_ID = '400000000000000002';
/** Recorded in this guild beside Kitten, with a picture of their own. */
const PET_ID = '400000000000000003';

/** A distinct picture per member, so serving one member another's would show. */
function png(): Buffer {
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);
}
const KITTEN_PNG = png();
const PET_PNG = png();

function seen(userId: string, avatarHash: string | null): SeenMember {
    return { userId, username: `user-${userId}`, globalName: null, nickname: null, avatarHash, isBot: false };
}

/** The served path of the operation `operationId`, its params filled in. */
async function servedPath(operationId: string, params: Record<string, string>): Promise<string> {
    const paths = (await buildOpenApiDocument()).paths ?? {};
    for (const [path, item] of Object.entries(paths)) {
        const operations = Object.values(item as Record<string, { operationId?: string } | undefined>);
        if (operations.some((operation) => operation?.operationId === operationId)) {
            return path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
                const value = params[name];
                if (!value) throw new Error(`No value for {${name}} in ${operationId}'s path.`);
                return value;
            });
        }
    }
    throw new Error(`No operation ${operationId} in the spec.`);
}

beforeAll(async () => {
    await ensureBlocksDiscovered();
    await migrateTestDatabase();
    await memberNamesRepo.recordPresent(GUILD_ID, [seen(KITTEN_ID, 'face1'), seen(BARE_ID, null), seen(PET_ID, 'petface')]);
    await memberAvatarsRepo.store({ userId: KITTEN_ID, avatarHash: 'face1', contentType: 'image/png', bytes: KITTEN_PNG }, new Date());
    // Still held for a moment after they removed it: the queue has not dropped it yet.
    await memberAvatarsRepo.store({ userId: BARE_ID, avatarHash: 'gone', contentType: 'image/png', bytes: png() }, new Date());
    await memberAvatarsRepo.store({ userId: PET_ID, avatarHash: 'petface', contentType: 'image/png', bytes: PET_PNG }, new Date());
});

describe('a kept avatar as served', () => {
    it("serves each member's own picture at the names answer's avatarUrl, as a picture the browser may keep", async () => {
        const app = buildApp();
        const names = await app.request(
            `${await servedPath('getMemberNames', { guildId: GUILD_ID })}?ids=${KITTEN_ID},${PET_ID}`
        );
        const urls = new Map(((await names.json()) as { members: MemberName[] }).members.map((member) => [member.userId, member.avatarUrl]));
        const kittenUrl = urls.get(KITTEN_ID);
        const petUrl = urls.get(PET_ID);
        if (!kittenUrl || !petUrl) throw new Error('The names answer gave no avatarUrl.');

        const kitten = await app.request(kittenUrl);
        const pet = await app.request(petUrl);

        expect(kitten.status).toBe(200);
        expect(Buffer.from(await kitten.arrayBuffer())).toEqual(KITTEN_PNG);
        expect(Buffer.from(await pet.arrayBuffer())).toEqual(PET_PNG);
        expect(kitten.headers.get('Content-Type')).toBe('image/png');
        expect(kitten.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(kitten.headers.get('Cache-Control')).toBe(PICTURE_CACHE_CONTROL);
    });

    it("refuses another server one it never held the person in, uncacheably", async () => {
        const response = await buildApp().request(
            await servedPath('getMemberAvatar', { guildId: OTHER_GUILD_ID, userId: KITTEN_ID })
        );

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: MEMBER_AVATAR_NOT_FOUND_SENTENCE });
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('serves none for someone who has since removed their avatar, and names none', async () => {
        const app = buildApp();
        const names = await app.request(`${await servedPath('getMemberNames', { guildId: GUILD_ID })}?ids=${BARE_ID}`);
        const response = await app.request(await servedPath('getMemberAvatar', { guildId: GUILD_ID, userId: BARE_ID }));

        expect(((await names.json()) as { members: MemberName[] }).members[0]?.avatarUrl).toBeNull();
        expect(response.status).toBe(404);
    });
});
