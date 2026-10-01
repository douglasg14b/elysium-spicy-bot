import SqliteDatabase from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { up as createTicketingConfig } from '../../../../features-system/data-persistence/migrations/2025-11-10-Create_Ticketing_Config';
import {
    down as unbindCategories,
    up as bindCategories,
} from '../../../../features-system/data-persistence/migrations/2026-10-01-Bind_Ticket_Categories_By_Id';

/**
 * The category-slot migration's sqlite arm, against real SQLite.
 *
 * Every assertion reads the row back as JSON text, never a fixture, so a migration that
 * matched no rows cannot pass. The postgres arm is different SQL (`jsonb_set`,
 * `jsonb_build_object`, `-`) and is not run here, which is recorded rather than claimed.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: Kysely<any>;

const BASE = {
    modTicketsDeployed: true,
    modTicketsDeployedChannelId: 'channel-1',
    modTicketsDeployedMessageId: 'message-1',
    moderationRoles: ['role-1'],
    ticketTypes: {},
};

const ALREADY_BOUND = {
    ...BASE,
    categories: {
        open: { name: 'Tickets', discordId: '111', provenance: 'adopted' },
        claimed: { name: 'Claimed', discordId: '222', provenance: 'created' },
        closed: null,
    },
};

async function readConfig(guildId: string): Promise<Record<string, unknown>> {
    const row = await sql<{ stored: string }>`select config as stored from ticketing_config where guild_id = ${guildId}`.execute(db);
    const stored = row.rows[0]?.stored;
    if (!stored) throw new Error(`No ticketing_config row for ${guildId}`);
    expect(typeof stored, 'config should still be JSON text on sqlite').toBe('string');
    return JSON.parse(stored) as Record<string, unknown>;
}

beforeAll(async () => {
    expect(process.env.DB_TYPE).toBe('sqlite');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db = new Kysely({ dialect: new SqliteDialect({ database: new SqliteDatabase(':memory:') }) }) as Kysely<any>;
    await createTicketingConfig(db);

    await sql`
        insert into ticketing_config (guild_id, config, ticket_number_inc, entity_version)
        values
            ('guild-named', ${JSON.stringify({
                ...BASE,
                supportTicketCategoryName: 'Support',
                claimedTicketCategoryName: 'Claimed',
                closedTicketCategoryName: 'Closed',
            })}, 3, 1),
            ('guild-unnamed', ${JSON.stringify({
                ...BASE,
                supportTicketCategoryName: '',
                claimedTicketCategoryName: '',
                closedTicketCategoryName: '',
            })}, 0, 1),
            ('guild-bound', ${JSON.stringify(ALREADY_BOUND)}, 1, 1)
    `.execute(db);

    await bindCategories(db);
});

afterAll(async () => {
    await db.destroy();
});

describe('binding ticket categories by id', () => {
    it('carries each old name into an unbound slot and removes the name keys', async () => {
        const config = await readConfig('guild-named');

        expect(config.categories).toEqual({
            open: { name: 'Support', discordId: null },
            claimed: { name: 'Claimed', discordId: null },
            closed: { name: 'Closed', discordId: null },
        });
        expect(config).not.toHaveProperty('supportTicketCategoryName');
        expect(config).not.toHaveProperty('claimedTicketCategoryName');
        expect(config).not.toHaveProperty('closedTicketCategoryName');
        // The members it has no business touching.
        expect(config.moderationRoles).toEqual(['role-1']);
        expect(config.modTicketsDeployedChannelId).toBe('channel-1');
    });

    it('turns an empty name into "nothing chosen", not a slot named ""', async () => {
        const config = await readConfig('guild-unnamed');

        expect(config.categories).toEqual({ open: null, claimed: null, closed: null });
    });

    it('leaves a row that already holds bindings alone', async () => {
        expect((await readConfig('guild-bound')).categories).toEqual(ALREADY_BOUND.categories);
    });

    it('is a no-op when run again', async () => {
        const before = await readConfig('guild-named');
        await bindCategories(db);
        expect(await readConfig('guild-named')).toEqual(before);
    });

    it('down restores the names and drops the slots', async () => {
        await unbindCategories(db);

        const named = await readConfig('guild-named');
        expect(named).not.toHaveProperty('categories');
        expect(named.supportTicketCategoryName).toBe('Support');
        expect(named.claimedTicketCategoryName).toBe('Claimed');
        expect(named.closedTicketCategoryName).toBe('Closed');

        // A bound slot keeps its name; an empty one goes back to ''.
        const bound = await readConfig('guild-bound');
        expect(bound.supportTicketCategoryName).toBe('Tickets');
        expect(bound.closedTicketCategoryName).toBe('');

        // And up again reaches the same place.
        await bindCategories(db);
        expect((await readConfig('guild-named')).categories).toEqual({
            open: { name: 'Support', discordId: null },
            claimed: { name: 'Claimed', discordId: null },
            closed: { name: 'Closed', discordId: null },
        });
    });
});
