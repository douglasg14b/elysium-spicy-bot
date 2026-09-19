import { database, type DatabaseClient } from '../../../features-system/data-persistence/database';
import {
    validateJourneyDeclaration,
    type JourneyDeclaration,
    type ResourceDeclaration,
} from '../logic/resourceDeclaration';
import type { JourneyEntity } from './journeysSchema';

export interface CreateJourneyInput {
    guildId: string;
    journeyKey: string;
    name: string;
    description?: string;
    resources: readonly ResourceDeclaration[];
    /** The flow whose authoring created this journey, when one did. */
    createdForFlowId?: string;
}

export interface UpdateJourneyInput {
    name?: string;
    description?: string | null;
    resources?: readonly ResourceDeclaration[];
}

/**
 * Raised when a write would break the per-guild uniqueness of a journey key.
 *
 * A distinct type rather than a bare `Error` because the API turns it into a 409,
 * and matching on a message string to decide a status code is the kind of coupling
 * that breaks silently when someone rewords the message.
 */
export class DuplicateJourneyKeyError extends Error {
    constructor(guildId: string, journeyKey: string) {
        super(`Guild ${guildId} already has a journey with the key "${journeyKey}".`);
        this.name = 'DuplicateJourneyKeyError';
    }
}

/**
 * Persistence for journeys.
 *
 * Declarations are validated on every write *and* on read, mirroring `FlowsRepo`'s
 * treatment of the graph. Reading matters as much as writing here: a journey row is
 * the input to an install plan that mutates a real guild, and
 * `validateJourneyDeclaration` is what guarantees parents exist and keys are unique
 * before `orderResourcesForApply` is asked to sort them. A row corrupted by hand or
 * by an older schema must fail loudly at the repo boundary, not halfway through an
 * apply with two channels already created.
 */
export class JourneysRepo {
    constructor(private readonly db: DatabaseClient = database) {}

    async listByGuildId(guildId: string): Promise<JourneyEntity[]> {
        const rows = await this.db
            .selectFrom('journeys')
            .selectAll()
            .where('guildId', '=', guildId)
            .orderBy('createdAt', 'asc')
            .execute();

        return rows.map((row) => this.assertValidDeclaration(row));
    }

    async getByKey(guildId: string, journeyKey: string): Promise<JourneyEntity | null> {
        const row = await this.db
            .selectFrom('journeys')
            .selectAll()
            .where('guildId', '=', guildId)
            .where('journeyKey', '=', journeyKey)
            .executeTakeFirst();

        return row ? this.assertValidDeclaration(row) : null;
    }

    async create(input: CreateJourneyInput): Promise<JourneyEntity> {
        validateJourneyDeclaration(toDeclaration(input));

        // Checked before the insert so the caller gets the typed error rather than a
        // dialect-specific unique-constraint violation, which reads differently on
        // sqlite and postgres. The unique index is still the real guarantee — this
        // check is for the message, not for correctness.
        const existing = await this.getByKey(input.guildId, input.journeyKey);
        if (existing) {
            throw new DuplicateJourneyKeyError(input.guildId, input.journeyKey);
        }

        const now = new Date().toISOString();
        await this.db
            .insertInto('journeys')
            .values({
                journeyKey: input.journeyKey,
                guildId: input.guildId,
                name: input.name,
                description: input.description ?? null,
                resources: JSON.stringify(input.resources),
                createdForFlowId: input.createdForFlowId ?? null,
                createdAt: now,
                updatedAt: now,
            })
            .execute();

        const saved = await this.getByKey(input.guildId, input.journeyKey);
        if (!saved) {
            throw new Error(
                `Journey create succeeded but row was not found for ${input.guildId}/${input.journeyKey}.`
            );
        }

        return saved;
    }

    async update(
        guildId: string,
        journeyKey: string,
        input: UpdateJourneyInput
    ): Promise<JourneyEntity> {
        const existing = await this.getByKey(guildId, journeyKey);
        if (!existing) {
            throw new Error(`No journey ${journeyKey} in guild ${guildId}.`);
        }

        const updateData: Record<string, unknown> = { updatedAt: new Date().toISOString() };

        if (input.name !== undefined) {
            updateData.name = input.name;
        }
        if (input.description !== undefined) {
            updateData.description = input.description;
        }
        if (input.resources !== undefined) {
            // Validated against the *merged* result, not the patch alone, so a rename
            // combined with a resource edit is checked as the journey it will become.
            validateJourneyDeclaration({
                journeyKey,
                name: input.name ?? existing.name,
                description: input.description ?? existing.description ?? undefined,
                resources: input.resources,
            });
            updateData.resources = JSON.stringify(input.resources);
        }

        await this.db
            .updateTable('journeys')
            .set(updateData)
            .where('guildId', '=', guildId)
            .where('journeyKey', '=', journeyKey)
            .execute();

        const saved = await this.getByKey(guildId, journeyKey);
        if (!saved) {
            throw new Error(
                `Journey update succeeded but row was not found for ${guildId}/${journeyKey}.`
            );
        }

        return saved;
    }

    /**
     * Delete a journey row.
     *
     * Deliberately leaves `resource_bindings` alone. Those rows record channels and
     * roles that **exist in the guild**, and deleting the record of what this bot
     * created would orphan real Discord objects — nothing could later find them to
     * repair or remove them. Tearing down installed structure is uninstall's job
     * (5B), and it is a different, destructive operation that an operator has to ask
     * for explicitly.
     */
    async deleteByKey(guildId: string, journeyKey: string): Promise<void> {
        await this.db
            .deleteFrom('journeys')
            .where('guildId', '=', guildId)
            .where('journeyKey', '=', journeyKey)
            .execute();
    }

    /**
     * The SqliteJsonPlugin parses `resources` back into an array, but a row written by
     * an older schema or edited by hand could still be malformed.
     */
    private assertValidDeclaration(row: JourneyEntity): JourneyEntity {
        if (!Array.isArray(row.resources)) {
            throw new Error(
                `Journey ${row.journeyKey} has a stored resources column that is not an array.`
            );
        }

        validateJourneyDeclaration(toDeclarationFromRow(row));
        return row;
    }
}

/** A stored row as the planner's input type. */
export function toDeclarationFromRow(row: JourneyEntity): JourneyDeclaration {
    return {
        journeyKey: row.journeyKey,
        name: row.name,
        description: row.description ?? undefined,
        resources: row.resources,
    };
}

function toDeclaration(input: CreateJourneyInput): JourneyDeclaration {
    return {
        journeyKey: input.journeyKey,
        name: input.name,
        description: input.description,
        resources: input.resources,
    };
}

export const journeysRepo = new JourneysRepo();
