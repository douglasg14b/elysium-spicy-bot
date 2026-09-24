import { database } from '../../../features-system/data-persistence/database';
import type { ResourceKind } from '../logic/resourceDeclaration';
import type { ResourceBindingEntity, ResourceBindingState } from './resourceBindingsSchema';

/**
 * Persistence for resource bindings.
 *
 * Every resolve is by `discordId`, never by name. Matching on a display name is the
 * defect issue #22 records in the ticket feature: a rename in Discord silently
 * produces a duplicate rather than an error.
 */
export class ResourceBindingsRepo {
    async listByJourney(guildId: string, journeyKey: string): Promise<ResourceBindingEntity[]> {
        return database
            .selectFrom('resource_bindings')
            .selectAll()
            .where('guildId', '=', guildId)
            .where('journeyKey', '=', journeyKey)
            .execute();
    }

    /**
     * Every binding in a guild, across all its journeys.
     *
     * For the flows list, which needs an install state per row and would otherwise ask
     * `listByJourney` once per journey — an N+1 over a list that grows with the server,
     * and the shape that looks fine on a developer's two journeys. Same reasoning as
     * `loadFlowJourneyIndex`, which this feeds.
     *
     * Returns rows rather than counts because the caller has to tell a **live** binding
     * from an `intended` one: an intent with no `discordId` is the crash-safety record
     * written before the guild was touched, and counting it as installed would report a
     * journey as live on the strength of an install that failed.
     */
    async listByGuild(guildId: string): Promise<ResourceBindingEntity[]> {
        return database
            .selectFrom('resource_bindings')
            .selectAll()
            .where('guildId', '=', guildId)
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
            .where('journeyKey', '=', journeyKey)
            .where('resourceKey', '=', resourceKey)
            .executeTakeFirst();

        return binding ?? null;
    }

    /**
     * Record the intent to provision a resource, before the guild is touched.
     *
     * Returns the existing row when one is already present, which is what makes a
     * re-run converge instead of duplicating: the unique index on the key triple
     * means a second install of the same journey finds its own prior intent.
     *
     * `onConflict ... doNothing` rather than a check-then-insert, so two concurrent
     * installs cannot both pass the check and then race the insert.
     */
    async recordIntent(input: {
        guildId: string;
        journeyKey: string;
        resourceKey: string;
        kind: ResourceKind;
        name: string;
    }): Promise<ResourceBindingEntity> {
        const now = new Date().toISOString();

        await database
            .insertInto('resource_bindings')
            .values({
                guildId: input.guildId,
                journeyKey: input.journeyKey,
                resourceKey: input.resourceKey,
                kind: input.kind,
                state: 'intended',
                discordId: null,
                name: input.name,
                createdAt: now,
                updatedAt: now,
            })
            .onConflict((oc) => oc.columns(['guildId', 'journeyKey', 'resourceKey']).doNothing())
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
     */
    async settle(input: {
        id: number;
        discordId: string;
        state: Extract<ResourceBindingState, 'created' | 'adopted'>;
        name: string;
    }): Promise<boolean> {
        const result = await database
            .updateTable('resource_bindings')
            .set({
                discordId: input.discordId,
                state: input.state,
                name: input.name,
                updatedAt: new Date().toISOString(),
            })
            .where('id', '=', input.id)
            .where('state', '=', 'intended')
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
     * underneath it. Zero rows back is the refusal.
     */
    async rebind(input: {
        id: number;
        expectedDiscordId: string;
        discordId: string;
        state: Extract<ResourceBindingState, 'created' | 'adopted'>;
        name: string;
    }): Promise<boolean> {
        const result = await database
            .updateTable('resource_bindings')
            .set({
                discordId: input.discordId,
                state: input.state,
                name: input.name,
                updatedAt: new Date().toISOString(),
            })
            .where('id', '=', input.id)
            .where('discordId', '=', input.expectedDiscordId)
            .executeTakeFirst();

        return Number(result.numUpdatedRows) > 0;
    }

    /**
     * Refresh the cached name of a settled binding.
     *
     * Deliberately *not* `rebind`, which exists to point a row at a different object
     * and takes a new `discordId` to do it. A rename repair changes nothing about
     * identity — it is the same channel, put back to the name the journey declared —
     * so it must not go through a call whose whole purpose is to move a binding.
     *
     * The name is diagnostics-only and never used for lookup (see the schema's note on
     * issue #22), so a stale one breaks nothing functional. It is updated anyway
     * because every later drift report and every teardown preview describes the
     * resource by this name, and one that disagrees with the guild makes a report an
     * operator cannot match up to what they are looking at.
     *
     * Guarded on the snowflake rather than the row id, because the caller is holding a
     * live object and that is the fact worth checking: zero rows back means the
     * binding moved underneath the repair, which is a refusal rather than an error.
     */
    async renameBinding(input: { discordId: string; name: string }): Promise<boolean> {
        const result = await database
            .updateTable('resource_bindings')
            .set({ name: input.name, updatedAt: new Date().toISOString() })
            .where('discordId', '=', input.discordId)
            .where('state', '!=', 'intended')
            .executeTakeFirst();

        return Number(result.numUpdatedRows) > 0;
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
     * object is already gone. A row removed while its channel still stands would
     * orphan that channel with nothing left that knows we made it.
     */
    async forget(id: number): Promise<boolean> {
        const result = await database
            .deleteFrom('resource_bindings')
            .where('id', '=', id)
            .executeTakeFirst();

        return Number(result.numDeletedRows) > 0;
    }
}

export const resourceBindingsRepo = new ResourceBindingsRepo();
