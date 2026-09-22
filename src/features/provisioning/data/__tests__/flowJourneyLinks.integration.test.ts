import SqliteDatabase from 'better-sqlite3';
import {
    CamelCasePlugin,
    DummyDriver,
    Kysely,
    PostgresAdapter,
    PostgresIntrospector,
    PostgresQueryCompiler,
    SqliteDialect,
    type LogEvent,
} from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../../../../features-system/data-persistence/database';
import { up as createFlows } from '../../../../features-system/data-persistence/migrations/2026-09-11-Create_Flows';
import { up as createResourceBindings } from '../../../../features-system/data-persistence/migrations/2026-09-18-Create_Resource_Bindings';
import { up as createJourneys } from '../../../../features-system/data-persistence/migrations/2026-09-19-Create_Journeys';
import {
    down as dropFlowJourneyLinks,
    up as createFlowJourneyLinks,
} from '../../../../features-system/data-persistence/migrations/2026-09-22-Create_Flow_Journey_Links';
import { SqliteJsonPlugin } from '../../../../features-system/data-persistence/plugins/sqliteJsonPlugin';
import { FlowJourneyLinksRepo } from '../flowJourneyLinksRepo';

/**
 * The link table against real SQL, and the backfill that seeds it.
 *
 * Both questions here have a failure mode a mock reports as passing. The backfill is
 * the sharper one: a migration that writes **zero** rows looks exactly like one whose
 * assertions are vacuous, and this repo has shipped that shape of false pass before.
 * So the journeys are inserted first, the migration runs over them, and the assertions
 * count rows it had to actually produce.
 *
 * Each case builds its own database because the thing under test is a migration —
 * running it once in `beforeAll` would leave every later case asserting against rows a
 * previous one seeded.
 */

const GUILD = 'guild-1';
const OTHER_GUILD = 'guild-2';

const RESOURCES = [{ key: 'qa-channel', kind: 'textChannel', defaultName: 'questions' }];

let db: Kysely<any>;

beforeEach(async () => {
    process.env.DB_TYPE = 'sqlite';

    db = new Kysely<any>({
        dialect: new SqliteDialect({ database: new SqliteDatabase(':memory:') }),
        plugins: [new SqliteJsonPlugin<any>({ journeys: ['resources'] }), new CamelCasePlugin()],
    });

    await createFlows(db);
    await createResourceBindings(db);
    await createJourneys(db);
});

afterEach(async () => {
    await db.destroy();
});

/** A journey row written straight to the table, so the backfill has something to find. */
async function insertJourney(input: {
    guildId: string;
    journeyKey: string;
    createdForFlowId: string | null;
}): Promise<void> {
    const now = new Date().toISOString();
    await db
        .insertInto('journeys')
        .values({
            journeyKey: input.journeyKey,
            guildId: input.guildId,
            name: `Journey ${input.journeyKey}`,
            description: null,
            resources: JSON.stringify(RESOURCES),
            createdForFlowId: input.createdForFlowId,
            createdAt: now,
            updatedAt: now,
        })
        .execute();
}

async function allLinks(): Promise<{ guildId: string; flowId: string; journeyKey: string }[]> {
    return db
        .selectFrom('flow_journey_links')
        .select(['guildId', 'flowId', 'journeyKey'])
        .orderBy('id', 'asc')
        .execute();
}

describe('the flow_journey_links backfill', () => {
    it('writes exactly one link per flow-owned journey, and none for a standalone one', async () => {
        await insertJourney({ guildId: GUILD, journeyKey: 'flow-a', createdForFlowId: 'flow-a' });
        await insertJourney({ guildId: GUILD, journeyKey: 'flow-b', createdForFlowId: 'flow-b' });
        // Standalone: `POST /journeys` writes no owner. Inventing an attachment for it
        // would be the migration deciding a key collision is an ownership claim.
        await insertJourney({ guildId: GUILD, journeyKey: 'shared-onboarding', createdForFlowId: null });

        await createFlowJourneyLinks(db);

        const links = await allLinks();
        // The count is asserted first and exactly: "two" is the claim, and a backfill
        // that wrote nothing would satisfy any assertion phrased as "no bad rows".
        expect(links).toHaveLength(2);
        expect(links).toEqual([
            { guildId: GUILD, flowId: 'flow-a', journeyKey: 'flow-a' },
            { guildId: GUILD, flowId: 'flow-b', journeyKey: 'flow-b' },
        ]);
        expect(links.some((link) => link.journeyKey === 'shared-onboarding')).toBe(false);
    });

    it('keeps each guild the owner of its own links', async () => {
        // The same journey key in two guilds, which is legal: keys are unique per guild.
        await insertJourney({ guildId: GUILD, journeyKey: 'onboarding', createdForFlowId: 'flow-a' });
        await insertJourney({
            guildId: OTHER_GUILD,
            journeyKey: 'onboarding',
            createdForFlowId: 'flow-b',
        });

        await createFlowJourneyLinks(db);

        expect(await allLinks()).toEqual([
            { guildId: GUILD, flowId: 'flow-a', journeyKey: 'onboarding' },
            { guildId: OTHER_GUILD, flowId: 'flow-b', journeyKey: 'onboarding' },
        ]);
    });

    it('produces no rows at all when every journey is standalone', async () => {
        await insertJourney({ guildId: GUILD, journeyKey: 'onboarding', createdForFlowId: null });

        await createFlowJourneyLinks(db);

        expect(await allLinks()).toHaveLength(0);
    });
});

describe('the migration itself', () => {
    it('drops cleanly and can be applied again', async () => {
        await insertJourney({ guildId: GUILD, journeyKey: 'flow-a', createdForFlowId: 'flow-a' });
        await createFlowJourneyLinks(db);

        await dropFlowJourneyLinks(db);
        // `down` must take the indexes with the table, or re-applying collides on the
        // index name rather than the table — which is the failure a rollback would hit
        // in production and never here, since nothing else exercises this path.
        await createFlowJourneyLinks(db);

        expect(await allLinks()).toHaveLength(1);
    });

    it('emits the same table and indexes on the postgres arm', async () => {
        // `DB_TYPE` is a module-level const in `environment.ts`, frozen at import — so
        // setting `process.env` here would **not** switch arms, and an earlier draft of
        // this test silently compiled the sqlite arm while claiming to check postgres.
        // Re-importing under a stubbed env is what actually selects the other branch.
        vi.resetModules();
        vi.stubEnv('DB_TYPE', 'postgres');
        // `environment.ts` requires this once `DB_TYPE` is postgres. Nothing connects —
        // the dummy driver below never opens a socket — but the module must load.
        vi.stubEnv('PG_CONNECTION_STRING', 'postgres://vitest/never-connected');

        const statements: string[] = [];
        const compileOnly = new Kysely<any>({
            dialect: {
                createAdapter: () => new PostgresAdapter(),
                createDriver: () => new DummyDriver(),
                createIntrospector: (database) => new PostgresIntrospector(database),
                createQueryCompiler: () => new PostgresQueryCompiler(),
            },
            log: (event: LogEvent) => {
                statements.push(event.query.sql);
            },
        });

        try {
            // Compiled, not executed — there is no postgres server here, and this arm
            // is otherwise never exercised by anything despite shipping to production.
            const postgresMigration = await import(
                '../../../../features-system/data-persistence/migrations/2026-09-22-Create_Flow_Journey_Links'
            );
            await postgresMigration.up(compileOnly);
        } finally {
            await compileOnly.destroy();
            vi.unstubAllEnvs();
            vi.resetModules();
        }

        // The emitted SQL is **asserted**, not merely awaited. Checking only that the
        // builders did not throw proves nothing: Kysely passes column types to the
        // server verbatim, so a deliberately invalid one compiles perfectly happily.
        const ddl = statements.join('\n');

        // The same shape the sqlite arm produces, in postgres spelling. A dialect that
        // silently disagreed about a column or an index would only surface in
        // production, on one deployment.
        expect(ddl).toContain('create table "flow_journey_links"');
        // `serial`, not sqlite's `integer … autoincrement` — proof this really is the
        // other arm and not the sqlite one compiled through a postgres compiler.
        expect(ddl).toContain('"id" serial primary key');
        expect(ddl).toContain('"guild_id" text not null');
        expect(ddl).toContain('"flow_id" text not null');
        expect(ddl).toContain('"journey_key" text not null');
        expect(ddl).toContain('"created_at" timestamptz default now() not null');
        expect(ddl).toContain('"updated_at" timestamptz default now() not null');
        // The constraint the whole "one flow, at most one journey" invariant rests on.
        expect(ddl).toContain(
            'create unique index "flow_journey_links_flow_unique_idx" on "flow_journey_links" ("guild_id", "flow_id")'
        );
        expect(ddl).toContain(
            'create index "flow_journey_links_guild_journey_idx" on "flow_journey_links" ("guild_id", "journey_key")'
        );
        // And the backfill, which is the part a dialect difference would silently skip.
        expect(ddl).toContain('insert into flow_journey_links');
        expect(ddl).toContain('created_for_flow_id is not null');
    });
});

describe('FlowJourneyLinksRepo', () => {
    let repo: FlowJourneyLinksRepo;

    beforeEach(async () => {
        await createFlowJourneyLinks(db);
        repo = new FlowJourneyLinksRepo(db as unknown as DatabaseClient);
    });

    it('holds several flows against one journey, and one journey per flow', async () => {
        await repo.attach({ guildId: GUILD, flowId: 'flow-a', journeyKey: 'onboarding' });
        await repo.attach({ guildId: GUILD, flowId: 'flow-b', journeyKey: 'onboarding' });

        // The product of the whole slice: a journey holding more than one flow.
        expect(await repo.listFlowIdsForJourney(GUILD, 'onboarding')).toEqual(['flow-a', 'flow-b']);
        expect(await repo.getJourneyKeyForFlow(GUILD, 'flow-a')).toBe('onboarding');
    });

    it('moves a flow rather than duplicating it when it is attached again', async () => {
        await repo.attach({ guildId: GUILD, flowId: 'flow-a', journeyKey: 'onboarding' });
        await repo.attach({ guildId: GUILD, flowId: 'flow-a', journeyKey: 'verification' });

        // The unique index is what makes this a move. Without it the flow would install
        // two journeys, and every flow-first lookup would pick one arbitrarily.
        expect(await repo.getJourneyKeyForFlow(GUILD, 'flow-a')).toBe('verification');
        expect(await repo.listFlowIdsForJourney(GUILD, 'onboarding')).toEqual([]);
        expect(await allLinks()).toHaveLength(1);
    });

    it('scopes every read to its guild', async () => {
        await repo.attach({ guildId: GUILD, flowId: 'flow-a', journeyKey: 'onboarding' });

        expect(await repo.getJourneyKeyForFlow(OTHER_GUILD, 'flow-a')).toBeNull();
        expect(await repo.listFlowIdsForJourney(OTHER_GUILD, 'onboarding')).toEqual([]);
    });

    it('detaches a flow without disturbing the others on the journey', async () => {
        await repo.attach({ guildId: GUILD, flowId: 'flow-a', journeyKey: 'onboarding' });
        await repo.attach({ guildId: GUILD, flowId: 'flow-b', journeyKey: 'onboarding' });

        expect(await repo.detachFlow(GUILD, 'flow-a')).toBe(true);

        expect(await repo.listFlowIdsForJourney(GUILD, 'onboarding')).toEqual(['flow-b']);
        // Nothing to remove is not a failure, but it must say so.
        expect(await repo.detachFlow(GUILD, 'flow-a')).toBe(false);
    });
});
