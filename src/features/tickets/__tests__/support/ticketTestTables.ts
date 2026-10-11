import type { Kysely } from 'kysely';
import { database } from '../../../../features-system/data-persistence/database';
import { up as createTicketingConfig } from '../../../../features-system/data-persistence/migrations/2025-11-10-Create_Ticketing_Config';
import { up as createResourceBindings } from '../../../../features-system/data-persistence/migrations/2026-09-18-Create_Resource_Bindings';
import { up as createJourneys } from '../../../../features-system/data-persistence/migrations/2026-09-19-Create_Journeys';
import { up as ownerKeyResourceBindings } from '../../../../features-system/data-persistence/migrations/2026-10-10-Owner_Keyed_Resource_Bindings';
import { TICKETS_OWNER } from '../../../provisioning/data/resourceBindingsSchema';
import { TICKET_CATEGORY_SLOTS, type TicketingConfig } from '../../data/ticketingSchema';

/**
 * The tables a ticket config needs, for a suite that builds its own in-memory Kysely and
 * swaps it in for the `database` singleton.
 *
 * Since 2026-10-10 a config is two tables: the `ticketing_config` blob and the ticket
 * feature's category rows in `resource_bindings`, which `ticketingRepo` assembles on
 * every read. `journeys` comes along because a settings save names a category's other
 * owner by its journey's display name. Built by the real migrations, in order, never by
 * hand-written DDL — one list here rather than one per suite.
 *
 * The migrations are typed `Kysely<any>`, as every migration in this repo is.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createTicketTestTables(db: Kysely<any>): Promise<void> {
    await createTicketingConfig(db);
    await createResourceBindings(db);
    await createJourneys(db);
    await ownerKeyResourceBindings(db);
}

/**
 * Write a guild's category slots as the ticket feature's binding rows, in the shapes
 * `ticketingRepo` reads them back as: no row for `null`, an `intended` row for a name
 * with no category, a settled row for a bound one.
 *
 * Through the `database` singleton, so it lands wherever the suite pointed that: a
 * `vi.mock`ed in-memory client, or the migrated test database. What the blob's
 * `categories` member used to seed, now that the blob has none.
 */
export async function seedTicketCategorySlots(
    guildId: string,
    categories: Partial<TicketingConfig['categories']>
): Promise<void> {
    const now = new Date().toISOString();
    for (const slot of TICKET_CATEGORY_SLOTS) {
        const binding = categories[slot];
        if (!binding) continue;

        const state = binding.discordId ? binding.provenance : 'intended';
        await database
            .insertInto('resource_bindings')
            .values({
                guildId,
                ownerKind: TICKETS_OWNER.kind,
                ownerKey: TICKETS_OWNER.key,
                resourceKey: slot,
                kind: 'category',
                state,
                discordId: binding.discordId,
                name: binding.name,
                createdAt: now,
                updatedAt: now,
            })
            .onConflict((oc) =>
                oc
                    .columns(['guildId', 'ownerKind', 'ownerKey', 'resourceKey'])
                    .doUpdateSet({ state, discordId: binding.discordId, name: binding.name, updatedAt: now })
            )
            .execute();
    }
}
