import type { Expression, ExpressionBuilder, SqlBool } from 'kysely';
import { database, type Database, type DatabaseClient } from '../../../features-system/data-persistence/database';
import { DISCORD_RESOURCE_KINDS, type DiscordResourceKind, type ResourceKind } from '../logic/resourceDeclaration';
import {
    journeyOwner,
    type BindingOwner,
    type ResourceBindingEntity,
    type ResourceBindingState,
} from './resourceBindingsSchema';

/**
 * Persistence for resource bindings.
 *
 * Every resolve is by `discordId`, never by name. Matching on a display name was issue
 * #22 in the ticket feature: a rename in Discord silently produced a duplicate rather
 * than an error.
 *
 * **The journey methods are journey-scoped in SQL.** `listByJourney`, `get` and
 * `recordIntent` all name `owner_kind = 'journey'`, so a journey whose key happens to be
 * `tickets` never reads or collides with the ticket feature's rows. `listByGuild` is the
 * deliberate exception: the fences need every owner.
 *
 * The methods the ticket feature calls take an optional executor, defaulting to the
 * singleton, because tickets read and write their rows inside `mutateConfig`'s
 * transaction — and a singleton query from inside it deadlocks SQLite's one connection
 * (see `ticketsRepo.ts`).
 */
export class ResourceBindingsRepo {
    async listByJourney(guildId: string, journeyKey: string): Promise<ResourceBindingEntity[]> {
        return this.listByOwner(guildId, journeyOwner(journeyKey));
    }

    /** Every row one owner holds in a guild. */
    async listByOwner(
        guildId: string,
        owner: BindingOwner,
        executor: DatabaseClient = database
    ): Promise<ResourceBindingEntity[]> {
        return executor
            .selectFrom('resource_bindings')
            .selectAll()
            .where('guildId', '=', guildId)
            .where('ownerKind', '=', owner.kind)
            .where('ownerKey', '=', owner.key)
            .execute();
    }

    /**
     * Every binding in a guild, across every owner — each journey and the ticket feature.
     *
     * The fences read this: install's crash recovery must never claim an object anyone
     * else holds, uninstall must never delete one, and a claim names the owner that
     * already has it. So it is **unfiltered by owner on purpose**; a caller after one
     * journey's rows filters with `isJourneyBinding`.
     *
     * Also for the flows list, which needs an install state per row and would otherwise
     * ask `listByJourney` once per journey — an N+1 over a list that grows with the
     * server, and the shape that looks fine on a developer's two journeys. Same reasoning
     * as `loadFlowJourneyIndex`, which this feeds.
     *
     * Returns rows rather than counts because the caller has to tell a **live** binding
     * from an `intended` one: an intent with no `discordId` is the crash-safety record
     * written before the guild was touched, and counting it as installed would report a
     * journey as live on the strength of an install that failed.
     *
     * Ordered by owner so "the first other owner" is the same answer on every read.
     */
    async listByGuild(guildId: string, executor: DatabaseClient = database): Promise<ResourceBindingEntity[]> {
        return executor
            .selectFrom('resource_bindings')
            .selectAll()
            .where('guildId', '=', guildId)
            .orderBy('ownerKind')
            .orderBy('ownerKey')
            .orderBy('id')
            .execute();
    }

    async get(
        guildId: string,
        journeyKey: string,
        resourceKey: string
    ): Promise<ResourceBindingEntity | null> {
        const binding = await database
            .selectFrom('resource_bindings')
            .selectAll()
            .where('guildId', '=', guildId)
            .where('ownerKind', '=', 'journey')
            .where('ownerKey', '=', journeyKey)
            .where('resourceKey', '=', resourceKey)
            .executeTakeFirst();

        return binding ?? null;
    }

    /**
     * Record a journey's intent to provision a resource, before the guild is touched.
     *
     * Returns the existing row when one is already present, which is what makes a
     * re-run converge instead of duplicating: the unique index on owner and resource key
     * means a second install of the same journey finds its own prior intent.
     *
     * An upsert rather than a check-then-insert, so two concurrent installs cannot both
     * pass the check and then race the insert.
     *
     * Journeys only. The ticket feature never records an intent — Douglas's call on
     * 2026-10-10: its worst case is one empty duplicate category, deleted by hand.
     */
    async recordIntent(input: {
        guildId: string;
        journeyKey: string;
        resourceKey: string;
        /** A Discord kind only: a ticket type has nothing to half-make, so no intent. */
        kind: DiscordResourceKind;
        name: string;
        /**
         * Whether this attempt is about to *create* the object, rather than bind one that
         * already exists (adopt, recover). Only a create refreshes an existing intent —
         * see below.
         */
        startsCreate: boolean;
    }): Promise<ResourceBindingEntity> {
        const now = new Date().toISOString();

        await database
            .insertInto('resource_bindings')
            .values({
                guildId: input.guildId,
                ownerKind: 'journey',
                ownerKey: input.journeyKey,
                resourceKey: input.resourceKey,
                kind: input.kind,
                state: 'intended',
                discordId: null,
                name: input.name,
                createdAt: now,
                updatedAt: now,
            })
            /*
             * A settled row is always left exactly as it is.
             *
             * An `intended` row is refreshed when this attempt is about to create, so it
             * describes *this* attempt: crash recovery (`findInterruptedCreates`) looks for
             * an object with the intent's name and kind, created shortly after the intent's
             * timestamp. Left at the first attempt's values, a retry after a rename — or a
             * retry days later — would be searched for under the wrong name or outside its
             * window, and fall through to offering its own object up for adoption.
             *
             * An adopt or a recover binds an object that already exists, so it must not
             * move the timestamp: a recover whose own settle then failed would otherwise
             * leave an intent newer than the object it was recovering, and the next run
             * could no longer find it.
             */
            .onConflict((oc) => {
                const conflict = oc.columns(['guildId', 'ownerKind', 'ownerKey', 'resourceKey']);
                return input.startsCreate
                    ? conflict
                          .doUpdateSet({ kind: input.kind, name: input.name, createdAt: now, updatedAt: now })
                          .where('resource_bindings.state', '=', 'intended')
                    : conflict.doNothing();
            })
            .execute();

        const binding = await this.get(input.guildId, input.journeyKey, input.resourceKey);
        if (!binding) {
            throw new Error(
                `Failed to record provisioning intent for "${input.resourceKey}" in journey "${input.journeyKey}".`
            );
        }

        return binding;
    }

    /**
     * Attach the guild object a binding now points at.
     *
     * Guarded on `state = 'intended'` so this cannot overwrite a binding that is
     * already live. Zero rows back is the refusal, not an exception — the caller
     * decides whether losing the race is a problem, and for a converging install it
     * is not.
     *
     * **Also guarded on nobody else holding the object** (see {@link heldByNoOtherOwner}).
     * An adopt and a recover both bind an object that already existed: install checked
     * at plan time, but a ticket save or another journey's install holds a different lock
     * and may have claimed it since. Applied to a create as well, where it costs nothing
     * — a snowflake Discord has just minted is held by nobody — so there is no state
     * argument to get wrong. (A recover settles as `created`, which is how it slipped
     * past this guard when it applied to `adopted` alone.)
     *
     * **Writes `kind` too**, as `rebind` does: the row must describe the object it now
     * names. An intent left from an attempt of another kind would otherwise name a channel
     * as whatever it was declared as before.
     */
    async settle(input: {
        id: number;
        discordId: string;
        kind: DiscordResourceKind;
        state: Extract<ResourceBindingState, 'created' | 'adopted'>;
        name: string;
    }): Promise<boolean> {
        const result = await database
            .updateTable('resource_bindings')
            .set({
                discordId: input.discordId,
                kind: input.kind,
                state: input.state,
                name: input.name,
                updatedAt: new Date().toISOString(),
            })
            .where('id', '=', input.id)
            .where('state', '=', 'intended')
            .where(heldByNoOtherOwner(input.discordId))
            .executeTakeFirst();

        return Number(result.numUpdatedRows) > 0;
    }

    /**
     * Point a settled binding at a different guild object.
     *
     * The narrow case this exists for: the bound resource was deleted from the guild,
     * so the plan decided to recreate it. `settle` cannot be used — it only accepts
     * `intended` rows, which is the guard that stops a live binding being overwritten
     * — and leaving the old row would make the install report success while pointing
     * at a dead snowflake.
     *
     * Guarded on the id it is replacing, so it cannot clobber a binding that moved
     * underneath it, and on nobody else holding the new object, as `settle` is. Zero
     * rows back is the refusal.
     *
     * **Writes `kind`.** The row being replaced may be of another kind — a ticket type
     * row under a key now declared as a channel, the commonest way a kind changes. Left
     * as it was, the channel this install created would be recorded as a ticket type,
     * which every fence skips and uninstall only forgets: a created channel nothing would
     * ever delete.
     */
    async rebind(input: {
        id: number;
        expectedDiscordId: string;
        discordId: string;
        kind: DiscordResourceKind;
        state: Extract<ResourceBindingState, 'created' | 'adopted'>;
        name: string;
    }): Promise<boolean> {
        const result = await database
            .updateTable('resource_bindings')
            .set({
                discordId: input.discordId,
                kind: input.kind,
                state: input.state,
                name: input.name,
                updatedAt: new Date().toISOString(),
            })
            .where('id', '=', input.id)
            .where('discordId', '=', input.expectedDiscordId)
            .where(heldByNoOtherOwner(input.discordId))
            .executeTakeFirst();

        return Number(result.numUpdatedRows) > 0;
    }

    /**
     * Refresh the expected name of a settled binding.
     *
     * Deliberately *not* `rebind`, which exists to point a row at a different object
     * and takes a new `discordId` to do it. A rename repair changes nothing about
     * identity — it is the same channel, put back to the name the journey declared —
     * so it must not go through a call whose whole purpose is to move a binding.
     *
     * The name is never used to find an object (see the schema's note on issue #22), so
     * a stale one breaks no lookup. It is still the expected name: drift measures an
     * adopted object against it, and every later drift report and teardown preview
     * describes the resource by it, so one that disagrees with the guild makes a report
     * an operator cannot match up to what they are looking at.
     *
     * **Scoped by the row id, with the snowflake as the optimistic guard.** The first
     * version keyed on `discordId` alone, and that was wrong in a way worth recording:
     * `discord_id` carries no unique index — one owner's two ticket slots may share a
     * category, and legacy data may hold one object under two owners — so an UPDATE
     * keyed on it alone rewrites *every* row pointing at that object, in every guild and
     * under every owner, and the returned row count cannot tell a correctly-scoped write
     * from an over-broad one.
     *
     * Every sibling mutator here is scoped by `id` or by owner; this is no exception.
     * Zero rows back means the binding moved underneath the repair, which is a refusal
     * rather than an error — and with both predicates that answer is trustworthy.
     */
    async renameBinding(input: {
        id: number;
        expectedDiscordId: string;
        name: string;
    }): Promise<boolean> {
        const result = await database
            .updateTable('resource_bindings')
            .set({ name: input.name, updatedAt: new Date().toISOString() })
            .where('id', '=', input.id)
            .where('discordId', '=', input.expectedDiscordId)
            .where('state', '!=', 'intended')
            .executeTakeFirst();

        return Number(result.numUpdatedRows) > 0;
    }

    /**
     * Set one owner's binding for one resource key, whatever was there before.
     *
     * For rows that bypass the intent lifecycle, because nothing about them can be
     * half-made:
     *
     *  - the ticket feature's category slots, which never record an intent: an operator's
     *    save picks or creates a category, and the slot's row is simply written. The fence
     *    against taking another owner's object is the caller's, re-run on the same
     *    executor immediately before this (`setTicketSettings`);
     *  - a journey's `ticketType` rows, whose `discordId` is a type key rather than a
     *    snowflake (`applyInstallPlan`). A type may be shared by any number of journeys
     *    and the dashboard, since nothing ever deletes or rewrites one for a journey, so
     *    there is no fence to run.
     */
    async upsertBinding(
        input: {
            readonly guildId: string;
            readonly owner: BindingOwner;
            readonly resourceKey: string;
            readonly kind: ResourceKind;
            readonly state: Extract<ResourceBindingState, 'created' | 'adopted'>;
            readonly discordId: string;
            readonly name: string;
        },
        executor: DatabaseClient = database
    ): Promise<void> {
        const now = new Date().toISOString();

        await executor
            .insertInto('resource_bindings')
            .values({
                guildId: input.guildId,
                ownerKind: input.owner.kind,
                ownerKey: input.owner.key,
                resourceKey: input.resourceKey,
                kind: input.kind,
                state: input.state,
                discordId: input.discordId,
                name: input.name,
                createdAt: now,
                updatedAt: now,
            })
            .onConflict((oc) =>
                oc.columns(['guildId', 'ownerKind', 'ownerKey', 'resourceKey']).doUpdateSet({
                    kind: input.kind,
                    state: input.state,
                    discordId: input.discordId,
                    name: input.name,
                    updatedAt: now,
                })
            )
            .execute();
    }

    /**
     * Point every one of an owner's rows that held a deleted object at its replacement.
     *
     * One compare-and-set statement, for the ticket feature's recreate: scoped by guild,
     * owner and the deleted id, so two slots that shared the category are both repointed,
     * and a slot the operator re-linked in the meantime no longer matches and is left
     * alone. Returns how many rows moved; zero means nothing named the deleted id any
     * more.
     *
     * Scoped by owner as well as id for the reason `renameBinding` gives: an id-only
     * update would also move another owner's row that happened to hold the same object.
     */
    async repointOwned(input: {
        readonly guildId: string;
        readonly owner: BindingOwner;
        readonly expectedDiscordId: string;
        readonly discordId: string;
        readonly state: Extract<ResourceBindingState, 'created' | 'adopted'>;
    }): Promise<number> {
        const result = await database
            .updateTable('resource_bindings')
            .set({ discordId: input.discordId, state: input.state, updatedAt: new Date().toISOString() })
            .where('guildId', '=', input.guildId)
            .where('ownerKind', '=', input.owner.kind)
            .where('ownerKey', '=', input.owner.key)
            .where('discordId', '=', input.expectedDiscordId)
            .executeTakeFirst();

        return Number(result.numUpdatedRows);
    }

    /**
     * Drop a binding that was never settled.
     *
     * Used when an apply fails before the guild was mutated, so a stale `intended`
     * row does not make the next install believe a resource is half-created. Guarded
     * on the state for the same reason `settle` is: a live binding must survive.
     */
    async discardIntent(id: number): Promise<boolean> {
        const result = await database
            .deleteFrom('resource_bindings')
            .where('id', '=', id)
            .where('state', '=', 'intended')
            .executeTakeFirst();

        return Number(result.numDeletedRows) > 0;
    }

    /**
     * Drop one owner's rows under these keys, whatever state they are in.
     *
     * For the ticket feature, which records no intent and whose rows name categories it
     * keeps in Discord either way — so, unlike {@link forget}, no object is orphaned: a
     * type's own category going back to the server default, or the type being deleted.
     * The executor is required because both run inside the ticket config's transaction,
     * where a query on the singleton would deadlock SQLite's one connection.
     */
    async forgetOwned(
        guildId: string,
        owner: BindingOwner,
        resourceKeys: readonly string[],
        executor: DatabaseClient
    ): Promise<void> {
        if (resourceKeys.length === 0) return;
        await executor
            .deleteFrom('resource_bindings')
            .where('guildId', '=', guildId)
            .where('ownerKind', '=', owner.kind)
            .where('ownerKey', '=', owner.key)
            .where('resourceKey', 'in', [...resourceKeys])
            .execute();
    }

    /**
     * Drop a binding row whatever state it is in.
     *
     * The unguarded counterpart to {@link discardIntent}, and deliberately separate
     * from it rather than a looser version of it: `discardIntent` is guarded precisely
     * so an install's error path cannot destroy a live binding, and widening it would
     * remove that protection from every existing caller to serve one new one.
     *
     * **This removes only the record.** Whether the guild object it named may be
     * deleted is a question this repo has no business answering —
     * `buildUnpublishPlan` owns it, and the apply path calls this only after the
     * object is already gone, or for a `forget` it planned on purpose. A row removed
     * while its channel still stands would orphan that channel with nothing left that
     * knows we made it.
     */
    async forget(id: number): Promise<boolean> {
        const result = await database
            .deleteFrom('resource_bindings')
            .where('id', '=', id)
            .executeTakeFirst();

        return Number(result.numDeletedRows) > 0;
    }
}

/**
 * `NOT EXISTS` a settled row for the same guild and object under a different owner.
 *
 * Correlated on the row being updated (`resource_bindings.*` in the subquery is the outer
 * row), so the caller passes only the object's id and the guard knows whose row it is.
 * An `intended` row has no id, so it never matches.
 *
 * Only a Discord object's row matches; a `ticketType` row never does. Its `discordId` holds a type key, and a key
 * may be all digits — so without this a journey holding a ticket type keyed like a
 * snowflake would fence another journey off the channel that happens to carry it.
 *
 * **Accepted:** on postgres's READ COMMITTED, two concurrent conditional writes can each
 * see the other as absent. The backstop is uninstall, which forgets rather than deletes
 * an object another owner also holds (`buildUnpublishPlan`).
 */
function heldByNoOtherOwner(
    discordId: string
): (eb: ExpressionBuilder<Database, 'resource_bindings'>) => Expression<SqlBool> {
    return (eb) =>
        eb.not(
            eb.exists(
                eb
                    .selectFrom('resource_bindings as other')
                    .select('other.id')
                    .whereRef('other.guildId', '=', 'resource_bindings.guildId')
                    .where('other.discordId', '=', discordId)
                    .where('other.state', '!=', 'intended')
                    .where('other.kind', 'in', [...DISCORD_RESOURCE_KINDS])
                    .where((inner) =>
                        inner.or([
                            inner('other.ownerKind', '!=', inner.ref('resource_bindings.ownerKind')),
                            inner('other.ownerKey', '!=', inner.ref('resource_bindings.ownerKey')),
                        ])
                    )
            )
        );
}

export const resourceBindingsRepo = new ResourceBindingsRepo();
