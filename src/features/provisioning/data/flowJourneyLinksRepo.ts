import { database, type DatabaseClient } from '../../../features-system/data-persistence/database';

/**
 * Persistence for flow → journey attachments.
 *
 * Reads only ever ask one of two questions, and both are indexed:
 *
 *  - *"which journey does this flow install?"* — the five resolve sites, all flow-first;
 *  - *"which flows are attached to this journey?"* — what the journeys page lists and
 *    what the delete refusal needs in order to name what it is protecting.
 *
 * The repo holds no journey or flow bodies. A link is an association and nothing else,
 * so a caller that wants either side's row fetches it from that side's repo; joining
 * here would give this table opinions about two others it has no business holding.
 */
export class FlowJourneyLinksRepo {
    constructor(private readonly db: DatabaseClient = database) {}

    /** The journey key a flow is attached to, or null when it is attached to none. */
    async getJourneyKeyForFlow(guildId: string, flowId: string): Promise<string | null> {
        const row = await this.db
            .selectFrom('flow_journey_links')
            .select('journeyKey')
            .where('guildId', '=', guildId)
            .where('flowId', '=', flowId)
            .executeTakeFirst();

        return row?.journeyKey ?? null;
    }

    /**
     * Every flow attached to a journey.
     *
     * Ordered by creation so the list an operator is shown is stable between reads —
     * an unordered list that reshuffles makes a refusal message look like it changed
     * its mind.
     */
    async listFlowIdsForJourney(guildId: string, journeyKey: string): Promise<string[]> {
        const rows = await this.db
            .selectFrom('flow_journey_links')
            .select('flowId')
            .where('guildId', '=', guildId)
            .where('journeyKey', '=', journeyKey)
            .orderBy('createdAt', 'asc')
            .orderBy('id', 'asc')
            .execute();

        return rows.map((row) => row.flowId);
    }

    /**
     * Every link in a guild, for a list that has to show attachments on every row.
     *
     * One query rather than one per journey. The journeys page renders a row per journey
     * and names the flows attached to each, which through `listFlowIdsForJourney` is an
     * N+1 — and it is the shape that looks fine on the three journeys a developer has
     * and degrades on the forty an operator accumulates.
     *
     * Returned flat rather than grouped: grouping is the caller's presentation choice,
     * and a repo returning a `Map` would be making it on their behalf.
     */
    async listLinksForGuild(guildId: string): Promise<{ flowId: string; journeyKey: string }[]> {
        return this.db
            .selectFrom('flow_journey_links')
            .select(['flowId', 'journeyKey'])
            .where('guildId', '=', guildId)
            .orderBy('createdAt', 'asc')
            .orderBy('id', 'asc')
            .execute();
    }

    /**
     * Attach a flow to a journey, replacing whatever it was attached to before.
     *
     * An upsert rather than a check-then-insert, so two concurrent saves cannot both
     * pass the check and then race the insert — the unique index on `(guildId, flowId)`
     * is what decides, and `doUpdateSet` turns losing that race into a move rather than
     * a dialect-specific constraint error. Re-attaching a flow to the journey it is
     * already on is therefore a no-op that still succeeds, which is what makes the save
     * path in `PUT /flows/:flowId/resources` safe to run on every write.
     */
    async attach(input: { guildId: string; flowId: string; journeyKey: string }): Promise<void> {
        const now = new Date().toISOString();

        await this.db
            .insertInto('flow_journey_links')
            .values({
                guildId: input.guildId,
                flowId: input.flowId,
                journeyKey: input.journeyKey,
                createdAt: now,
                updatedAt: now,
            })
            .onConflict((oc) =>
                oc.columns(['guildId', 'flowId']).doUpdateSet({
                    journeyKey: input.journeyKey,
                    updatedAt: now,
                })
            )
            .execute();
    }

    /**
     * Detach a flow from whatever journey it is on.
     *
     * Removes only the association. The journey row and its `resource_bindings` are
     * untouched on purpose: bindings record channels and roles that **exist in the
     * guild**, and dropping them because a flow walked away would orphan real Discord
     * objects with nothing left that knows we made them. Tearing those down is
     * unpublish's job, and an operator has to ask for it.
     */
    async detachFlow(guildId: string, flowId: string): Promise<boolean> {
        const result = await this.db
            .deleteFrom('flow_journey_links')
            .where('guildId', '=', guildId)
            .where('flowId', '=', flowId)
            .executeTakeFirst();

        return Number(result.numDeletedRows) > 0;
    }
}

export const flowJourneyLinksRepo = new FlowJourneyLinksRepo();
