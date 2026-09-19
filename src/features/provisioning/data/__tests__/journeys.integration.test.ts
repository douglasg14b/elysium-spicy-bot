import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../../../features-system/data-persistence/database';
import { up as createFlows } from '../../../../features-system/data-persistence/migrations/2026-09-11-Create_Flows';
import { up as createResourceBindings } from '../../../../features-system/data-persistence/migrations/2026-09-18-Create_Resource_Bindings';
import { up as createJourneys } from '../../../../features-system/data-persistence/migrations/2026-09-19-Create_Journeys';
import { SqliteJsonPlugin } from '../../../../features-system/data-persistence/plugins/sqliteJsonPlugin';
import type { ResourceDeclaration } from '../../logic/resourceDeclaration';
import { DuplicateJourneyKeyError, JourneysRepo } from '../journeysRepo';

/**
 * The journeys repo against real SQL.
 *
 * The questions here cannot be answered by a mock: whether the unique index actually
 * rejects a duplicate key, whether the JSON column round-trips a declaration
 * unchanged, and whether validation genuinely runs at the read boundary on a row
 * already in the table. Each has a real failure mode that a stubbed repo would report
 * as passing.
 *
 * Runs the migrations' own sqlite arms — `flows` first, because the journeys
 * migration alters it — so the schema under test is the schema that ships.
 */

let db: Kysely<any>;
let repo: JourneysRepo;

const GUILD = 'guild-1';
const OTHER_GUILD = 'guild-2';

/**
 * A two-resource journey with a parent relationship, so ordering and parent
 * validation are exercised rather than just a flat list.
 */
const RESOURCES: readonly ResourceDeclaration[] = [
    { key: 'qa-category', kind: 'category', defaultName: 'Questions' },
    {
        key: 'qa-channel',
        kind: 'textChannel',
        defaultName: 'questions',
        parentKey: 'qa-category',
        permissions: [{ audience: 'everyone', access: 'readWrite' }],
    },
];

beforeAll(async () => {
    db = new Kysely<any>({
        dialect: new SqliteDialect({ database: new SqliteDatabase(':memory:') }),
        // Mirrors the production client for this table: the JSON plugin parses
        // `resources` back into an array, and CamelCasePlugin must follow it in the
        // same relative order the app uses.
        plugins: [new SqliteJsonPlugin<any>({ journeys: ['resources'] }), new CamelCasePlugin()],
    });

    process.env.DB_TYPE = 'sqlite';
    await createFlows(db);
    await createResourceBindings(db);
    await createJourneys(db);

    repo = new JourneysRepo(db as unknown as DatabaseClient);
});

afterAll(async () => {
    await db.destroy();
});

beforeEach(async () => {
    await db.deleteFrom('journeys').execute();
});

describe('JourneysRepo', () => {
    it('round-trips a declaration through the JSON column unchanged', async () => {
        await repo.create({
            guildId: GUILD,
            journeyKey: 'qa',
            name: 'Q&A',
            description: 'Questions and answers.',
            resources: RESOURCES,
        });

        const saved = await repo.getByKey(GUILD, 'qa');

        expect(saved).not.toBeNull();
        expect(saved?.name).toBe('Q&A');
        expect(saved?.description).toBe('Questions and answers.');
        // The whole point of the JSON column: nested permission intents and the
        // parentKey survive the write/read cycle exactly.
        expect(saved?.resources).toEqual(RESOURCES);
    });

    it('stores a null description rather than the string "null"', async () => {
        await repo.create({
            guildId: GUILD,
            journeyKey: 'qa',
            name: 'Q&A',
            resources: RESOURCES,
        });

        const saved = await repo.getByKey(GUILD, 'qa');
        expect(saved?.description).toBeNull();
    });

    it('rejects a second journey with the same key in the same guild', async () => {
        await repo.create({ guildId: GUILD, journeyKey: 'qa', name: 'Q&A', resources: RESOURCES });

        await expect(
            repo.create({ guildId: GUILD, journeyKey: 'qa', name: 'Other', resources: RESOURCES })
        ).rejects.toBeInstanceOf(DuplicateJourneyKeyError);
    });

    it('allows the same key in a different guild', async () => {
        await repo.create({ guildId: GUILD, journeyKey: 'qa', name: 'Q&A', resources: RESOURCES });
        await repo.create({
            guildId: OTHER_GUILD,
            journeyKey: 'qa',
            name: 'Q&A',
            resources: RESOURCES,
        });

        // The scope is per-guild. Two servers each having an `onboarding` journey is
        // the normal case, not a collision.
        expect(await repo.getByKey(GUILD, 'qa')).not.toBeNull();
        expect(await repo.getByKey(OTHER_GUILD, 'qa')).not.toBeNull();
    });

    it('refuses to create a journey whose resource names a parent it does not declare', async () => {
        await expect(
            repo.create({
                guildId: GUILD,
                journeyKey: 'broken',
                name: 'Broken',
                resources: [
                    {
                        key: 'orphan-channel',
                        kind: 'textChannel',
                        defaultName: 'orphan',
                        parentKey: 'category-that-does-not-exist',
                    },
                ],
            })
        ).rejects.toThrow(/does not declare/);

        // And nothing was written — a rejected declaration must not leave a row that
        // a later plan would read.
        expect(await repo.getByKey(GUILD, 'broken')).toBeNull();
    });

    it('validates the merged result on update, not the patch alone', async () => {
        await repo.create({ guildId: GUILD, journeyKey: 'qa', name: 'Q&A', resources: RESOURCES });

        // Removing the category while keeping the child that names it as parent is
        // only detectable by validating the journey the update would produce.
        await expect(
            repo.update(GUILD, 'qa', {
                resources: [
                    {
                        key: 'qa-channel',
                        kind: 'textChannel',
                        defaultName: 'questions',
                        parentKey: 'qa-category',
                    },
                ],
            })
        ).rejects.toThrow(/does not declare/);

        const unchanged = await repo.getByKey(GUILD, 'qa');
        expect(unchanged?.resources).toEqual(RESOURCES);
    });

    it('fails loudly when reading a row whose stored declaration is invalid', async () => {
        // Write a corrupt row *underneath* the repo, as a hand edit or an older schema
        // could. The read boundary is the last place to catch this before the row
        // becomes the input to a plan that mutates a real guild.
        const now = new Date().toISOString();
        await db
            .insertInto('journeys')
            .values({
                journeyKey: 'corrupt',
                guildId: GUILD,
                name: 'Corrupt',
                description: null,
                resources: JSON.stringify([
                    { key: 'dupe', kind: 'category', defaultName: 'One' },
                    { key: 'dupe', kind: 'category', defaultName: 'Two' },
                ]),
                createdAt: now,
                updatedAt: now,
            })
            .execute();

        await expect(repo.getByKey(GUILD, 'corrupt')).rejects.toThrow(/more than once/);
    });

    it('lists only the requested guild journeys', async () => {
        await repo.create({ guildId: GUILD, journeyKey: 'qa', name: 'Q&A', resources: RESOURCES });
        await repo.create({
            guildId: OTHER_GUILD,
            journeyKey: 'other',
            name: 'Other',
            resources: RESOURCES,
        });

        const listed = await repo.listByGuildId(GUILD);
        expect(listed.map((journey) => journey.journeyKey)).toEqual(['qa']);
    });

    it('leaves resource bindings alone when a journey is deleted', async () => {
        await repo.create({ guildId: GUILD, journeyKey: 'qa', name: 'Q&A', resources: RESOURCES });

        // A binding recording a channel that exists in the guild right now.
        const now = new Date().toISOString();
        await db
            .insertInto('resource_bindings')
            .values({
                guildId: GUILD,
                journeyKey: 'qa',
                resourceKey: 'qa-channel',
                kind: 'textChannel',
                state: 'created',
                discordId: '999000111',
                name: 'questions',
                createdAt: now,
                updatedAt: now,
            })
            .execute();

        await repo.deleteByKey(GUILD, 'qa');

        expect(await repo.getByKey(GUILD, 'qa')).toBeNull();

        // Cascading the delete would orphan a real Discord channel — nothing left in
        // the database could find it to repair or remove it later. Tearing down
        // installed structure is uninstall's job, and it is a separate, destructive
        // operation an operator has to ask for.
        const surviving = await db
            .selectFrom('resource_bindings')
            .selectAll()
            .where('guildId', '=', GUILD)
            .execute();
        expect(surviving).toHaveLength(1);
        expect(surviving[0].discordId).toBe('999000111');
    });
});
