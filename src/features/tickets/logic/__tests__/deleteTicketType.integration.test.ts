import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteJsonPlugin } from '../../../../features-system/data-persistence/plugins/sqliteJsonPlugin';
import { up as createTicketingConfig } from '../../../../features-system/data-persistence/migrations/2025-11-10-Create_Ticketing_Config';
import { up as createTickets } from '../../../../features-system/data-persistence/migrations/2026-09-17-Create_Tickets_Table';
import { defaultTicketTypes } from '../../data/defaultTicketTypes';
import type { TicketingConfig, TicketingConfigTable } from '../../data/ticketingSchema';
import type { TicketTable } from '../../data/ticketsSchema';

/**
 * `deleteTicketType` end to end: the **real** transaction meeting the **real** repo.
 *
 * This is the combination nothing else exercised, and its absence hid a Critical. Every
 * other test around this path injects a fake on one side or the other — `setTicketTypes`'s
 * unit tests fake `mutateConfig` (its body just calls the mutator) *and* fake `usage`, the
 * route tests mock `setTicketTypes` wholesale, and `mutateConfig.integration.test.ts` uses
 * real SQLite but with mutators that never query. So the real transaction had never once
 * met the real count.
 *
 * What that hid: `ticketTypeUsage` was called from inside `mutateConfig`'s callback but
 * issued its query on the module-level `database` singleton. Kysely's `SqliteDialect` has
 * **one** connection behind a mutex — "SQLite only has one single connection", per its own
 * driver — which the transaction holds for its whole duration. So the count waited on a
 * mutex that could not be released until the callback it was blocking returned: a hard
 * deadlock. Not merely a hung request either — it poisons the process's only connection, so
 * every later query for every feature queues behind it forever and the bot is dead until
 * restart. One click of "Delete type" did that, with a green suite and a clean typecheck.
 *
 * The fix threads the transaction through, so the assertions below are deliberately about
 * *completion* as much as about the answer. A test that only checked the refusal message
 * would have passed on the broken code right up until it hung.
 *
 * In-memory, so it costs nothing and cannot touch the dev database. sqlite only — the
 * postgres arm stays hand-reviewed, which is where this defect could not occur anyway
 * (`pg` pools connections, so the nested query would have taken a second one).
 */

interface TestDatabase {
    ticketing_config: TicketingConfigTable;
    tickets: TicketTable;
}

const sqliteFile = new SqliteDatabase(':memory:');

const db = new Kysely<TestDatabase>({
    dialect: new SqliteDialect({ database: sqliteFile }),
    plugins: [new CamelCasePlugin(), new SqliteJsonPlugin<TestDatabase>({ ticketing_config: ['config'] })],
});

vi.mock('../../../../features-system/data-persistence/database', () => ({
    get database() {
        return db;
    },
}));

const { deleteTicketType } = await import('../setTicketTypes');

const GUILD_ID = 'guild-1';

/**
 * The whole point of the test is that it cannot hang forever, so every call is raced
 * against a timer. Vitest's own `testTimeout` would eventually fail the run, but it fails
 * it as "timed out" with no indication that a deadlock is the reason — and on the broken
 * code it also leaves the shared connection wedged, so every *later* test in the file
 * fails too and the real cause is buried under the noise.
 */
const DEADLOCK_TIMEOUT_MS = 3000;

async function withinTimeout<T>(work: Promise<T>, label: string): Promise<T> {
    const sentinel = Symbol('timed-out');
    const timer = new Promise<typeof sentinel>((resolve) =>
        setTimeout(() => resolve(sentinel), DEADLOCK_TIMEOUT_MS)
    );
    const result = await Promise.race([work, timer]);
    if (result === sentinel) {
        throw new Error(
            `${label} did not settle within ${DEADLOCK_TIMEOUT_MS}ms — the count is almost ` +
                'certainly querying the singleton instead of the transaction it runs inside.'
        );
    }
    return result as T;
}

function baseConfig(): TicketingConfig {
    return {
        modTicketsDeployed: true,
        modTicketsDeployedChannelId: 'panel-channel',
        modTicketsDeployedMessageId: 'panel-message',
        supportTicketCategoryName: 'Support',
        claimedTicketCategoryName: 'Claimed',
        closedTicketCategoryName: 'Closed',
        moderationRoles: ['role-1'],
        ticketTypes: defaultTicketTypes(),
    };
}

async function seedConfig(): Promise<void> {
    await db.deleteFrom('ticketing_config').execute();
    await db.deleteFrom('tickets').execute();
    await db
        .insertInto('ticketing_config')
        .values({
            guildId: GUILD_ID,
            // The column takes a serialized string on insert and yields an object on read —
            // `JSONColumnType`'s whole point — so the seed writes text.
            config: JSON.stringify(baseConfig()),
            ticketNumberInc: 0,
            entityVersion: 1,
        })
        .execute();
}

async function seedTicket(type: string, status: 'open' | 'closed' | 'deleted', ticketNumber: number): Promise<void> {
    await db
        .insertInto('tickets')
        .values({
            guildId: GUILD_ID,
            ticketNumber,
            type,
            status,
            subjectId: 'subject-1',
            openerId: 'opener-1',
            claimerId: null,
            channelId: `channel-${ticketNumber}`,
            title: `Ticket ${ticketNumber}`,
            reason: 'because',
            openedAt: new Date().toISOString(),
        } as never)
        .execute();
}

beforeEach(async () => {
    await createTicketingConfig(db as never).catch(() => undefined);
    await createTickets(db as never).catch(() => undefined);
    await seedConfig();
});

describe('deleteTicketType against real sqlite', () => {
    it('settles rather than deadlocking when it has to count tickets inside the transaction', async () => {
        // The assertion that matters is that this resolves at all. On the pre-fix code it
        // never did, and it took the connection with it.
        const result = await withinTimeout(deleteTicketType(GUILD_ID, 'verification'), 'an unused-type delete');

        expect(result.ok).toBe(true);
    });

    it('removes an unused type and leaves the other declarations alone', async () => {
        await withinTimeout(deleteTicketType(GUILD_ID, 'verification'), 'an unused-type delete');

        const row = await db
            .selectFrom('ticketing_config')
            .select('config')
            .where('guildId', '=', GUILD_ID)
            .executeTakeFirstOrThrow();

        const types = (row.config as unknown as TicketingConfig).ticketTypes ?? {};
        expect(Object.keys(types)).toEqual(['support']);
    });

    it('refuses a type an open ticket still holds, naming the count', async () => {
        await seedTicket('verification', 'open', 41);

        const result = await withinTimeout(
            deleteTicketType(GUILD_ID, 'verification'),
            'an in-use-type delete'
        );

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('unreachable');
        expect(result.reason).toBe('type-in-use');
        // The count came back through the transaction rather than hanging, which is the
        // whole claim: a refusal message proves the query ran and returned.
        expect(result.message).toContain('41');
    });

    it('refuses a type only deleted tickets hold, because the record still needs its label', async () => {
        await seedTicket('verification', 'deleted', 42);

        const result = await withinTimeout(
            deleteTicketType(GUILD_ID, 'verification'),
            'a deleted-only-type delete'
        );

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('unreachable');
        expect(result.reason).toBe('type-in-use');
    });

    it('leaves the connection usable afterwards', async () => {
        await withinTimeout(deleteTicketType(GUILD_ID, 'verification'), 'an unused-type delete');

        // On the pre-fix code the mutex was never released, so this query — on the same
        // singleton every other feature uses — would hang too. That is the difference
        // between a failed request and a dead process, and it is worth asserting directly.
        const stillWorks = await withinTimeout(
            db.selectFrom('ticketing_config').select('guildId').execute(),
            'a follow-up query'
        );

        expect(stillWorks).toHaveLength(1);
    });
});
