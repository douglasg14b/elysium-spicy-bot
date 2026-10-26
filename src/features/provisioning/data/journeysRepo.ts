import { DB_TYPE } from '../../../environment';
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

/** What {@link JourneysRepo.updateAtVersion} did. */
export type VersionedJourneyWrite =
    | { readonly kind: 'written'; readonly journey: JourneyEntity }
    /** The row has moved on since the caller read it. Nothing was written. */
    | { readonly kind: 'stale' }
    | { readonly kind: 'missing' };

/** What {@link JourneysRepo.deleteForFlowAtVersion} did. */
export type VersionedJourneyDelete =
    | { readonly kind: 'deleted' }
    | { readonly kind: 'stale' }
    | { readonly kind: 'missing' };

/**
 * Whether `journey` is still the version a caller read: its `updatedAt`, which every write
 * through this repo moves forward. Compared as instants, not strings.
 */
function isVersion(journey: JourneyEntity, baseUpdatedAt: string): boolean {
    return new Date(journey.updatedAt).getTime() === new Date(baseUpdatedAt).getTime();
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
 * Raised when a stored journey row cannot be read as a declaration.
 *
 * Typed so a caller can tell "this row is corrupt" — a data problem worth naming to the
 * operator — from a driver or connection failure, which is an ordinary server error and
 * must not be dressed up as one. `cause` keeps the underlying complaint, for the log;
 * `journeyKey` names the row, for a response that must not carry the complaint itself.
 */
export class MalformedJourneyError extends Error {
    readonly journeyKey: string;

    constructor(journeyKey: string, cause: unknown) {
        super(
            `Journey ${journeyKey} is stored malformed: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause }
        );
        this.name = 'MalformedJourneyError';
        this.journeyKey = journeyKey;
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

    /**
     * Each journey's key and display name, and nothing else.
     *
     * For naming an owner in a refusal or a picker. Deliberately **not** validated, unlike
     * every other read here: a name is all it hands out, and validating the declarations
     * would let one malformed journey break the channel directory, every ticket settings
     * save, and every other journey's install — none of which read its resources.
     */
    async listNamesByGuildId(guildId: string): Promise<{ journeyKey: string; name: string }[]> {
        return this.db
            .selectFrom('journeys')
            .select(['journeyKey', 'name'])
            .where('guildId', '=', guildId)
            .execute();
    }

    /**
     * Each journey's key, display name and the ticket type keys it declares.
     *
     * For the ticket feature's delete refusal, which counts a journey as holding a type only
     * while the journey still exists and still declares it — a binding row left behind by a
     * deleted, emptied or merged-away journey must not lock a type nobody can release.
     * Unvalidated, for `listNamesByGuildId`'s reason: one malformed journey must not break
     * every ticket type delete; a row whose resources are not a list declares nothing.
     */
    async listTicketTypeDeclarations(
        guildId: string
    ): Promise<{ journeyKey: string; name: string; ticketTypeKeys: readonly string[] }[]> {
        const rows = await this.db
            .selectFrom('journeys')
            .select(['journeyKey', 'name', 'resources'])
            .where('guildId', '=', guildId)
            .execute();

        return rows.map((row) => ({
            journeyKey: row.journeyKey,
            name: row.name,
            ticketTypeKeys: Array.isArray(row.resources)
                ? row.resources.filter((resource) => resource?.kind === 'ticketType').map((resource) => resource.key)
                : [],
        }));
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

    /**
     * Write `input` over the journey as it stands, whatever version that is — a rename, or the
     * group route emptying a journey it has just merged away.
     *
     * Read and written under the lock {@link updateAtVersion} takes, in one transaction: the
     * next version is stamped from the row as it is at the write, so it can never equal or
     * trail one a concurrent versioned save has just committed. Read outside the lock, it
     * could — and a tab holding that save's version would then pass the check over this write.
     */
    async update(
        guildId: string,
        journeyKey: string,
        input: UpdateJourneyInput
    ): Promise<JourneyEntity> {
        return this.db.transaction().execute(async (transaction): Promise<JourneyEntity> => {
            const existing = await this.lockedRow(transaction, guildId, journeyKey);
            if (!existing) {
                throw new Error(`No journey ${journeyKey} in guild ${guildId}.`);
            }

            await this.writeUpdate(transaction, existing, input);

            const saved = await this.lockedRow(transaction, guildId, journeyKey);
            if (!saved) {
                throw new Error(
                    `Journey update succeeded but row was not found for ${guildId}/${journeyKey}.`
                );
            }

            return saved;
        });
    }

    /**
     * {@link update}, but only if the journey is still the version the caller read —
     * `baseUpdatedAt` is the `updatedAt` it was sent. The resource autosave's guard: both
     * resource PUTs replace the whole list, so a tab writing over a list it never saw would
     * delete whatever another tab, or a migration, put there since.
     *
     * Read, compared and written in one transaction, so a write landing in between cannot
     * slip past the comparison. The row is locked on Postgres only, for the reason
     * `flowsRepo.mutate` gives: READ COMMITTED does not stop a read-then-write losing an
     * update, and SQLite rejects `FOR UPDATE` while its one connection already serialises
     * every transaction. Only the transaction's own handle is used inside it — a singleton
     * repo there would wait on the connection the transaction holds.
     *
     * `stale` when the row has moved on, `missing` when it is gone. Throws what `update`
     * throws for declarations that disagree with each other, and `MalformedJourneyError`
     * for a stored row that cannot be read.
     */
    async updateAtVersion(
        guildId: string,
        journeyKey: string,
        baseUpdatedAt: string,
        input: UpdateJourneyInput
    ): Promise<VersionedJourneyWrite> {
        return this.db.transaction().execute(async (transaction): Promise<VersionedJourneyWrite> => {
            const current = await this.lockedRow(transaction, guildId, journeyKey);
            if (!current) return { kind: 'missing' };
            if (!isVersion(current, baseUpdatedAt)) return { kind: 'stale' };

            await this.writeUpdate(transaction, current, input);

            const saved = await this.lockedRow(transaction, guildId, journeyKey);
            if (!saved) {
                throw new Error(`Journey update succeeded but row was not found for ${guildId}/${journeyKey}.`);
            }
            return { kind: 'written', journey: saved };
        });
    }

    /**
     * Delete the journey one flow alone holds, with that flow's link, if the journey is still
     * the version the caller read — the empty-list save of `PUT /flows/{flowId}/resources`,
     * which is a stale tab's worst case: everything the journey declares, gone.
     *
     * The link and the row go in one transaction, under the lock {@link updateAtVersion}
     * takes. Deleting the row leaves `resource_bindings` alone, as {@link deleteByKey} does.
     */
    async deleteForFlowAtVersion(input: {
        readonly guildId: string;
        readonly journeyKey: string;
        readonly flowId: string;
        readonly baseUpdatedAt: string;
    }): Promise<VersionedJourneyDelete> {
        const { guildId, journeyKey, flowId, baseUpdatedAt } = input;

        return this.db.transaction().execute(async (transaction): Promise<VersionedJourneyDelete> => {
            const current = await this.lockedRow(transaction, guildId, journeyKey);
            if (!current) return { kind: 'missing' };
            if (!isVersion(current, baseUpdatedAt)) return { kind: 'stale' };

            await transaction
                .deleteFrom('flow_journey_links')
                .where('guildId', '=', guildId)
                .where('flowId', '=', flowId)
                .execute();
            await transaction
                .deleteFrom('journeys')
                .where('guildId', '=', guildId)
                .where('journeyKey', '=', journeyKey)
                .execute();
            return { kind: 'deleted' };
        });
    }

    /** The row, validated, locked on Postgres for the rest of `executor`'s transaction. */
    private async lockedRow(
        executor: DatabaseClient,
        guildId: string,
        journeyKey: string
    ): Promise<JourneyEntity | null> {
        let query = executor
            .selectFrom('journeys')
            .selectAll()
            .where('guildId', '=', guildId)
            .where('journeyKey', '=', journeyKey);
        if (DB_TYPE === 'postgres') {
            query = query.forUpdate();
        }

        const row = await query.executeTakeFirst();
        return row ? this.assertValidDeclaration(row) : null;
    }

    /**
     * Write `input` over `existing` on `executor`, stamping the next version.
     *
     * The version only ever moves forward, by a millisecond at least: two writes in one
     * millisecond would otherwise share an `updatedAt`, and a tab holding the first would pass
     * {@link updateAtVersion}'s check over the second.
     */
    private async writeUpdate(
        executor: DatabaseClient,
        existing: JourneyEntity,
        input: UpdateJourneyInput
    ): Promise<void> {
        const nextVersion = Math.max(Date.now(), new Date(existing.updatedAt).getTime() + 1);
        const updateData: Record<string, unknown> = { updatedAt: new Date(nextVersion).toISOString() };

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
                journeyKey: existing.journeyKey,
                name: input.name ?? existing.name,
                description: input.description ?? existing.description ?? undefined,
                resources: input.resources,
            });
            updateData.resources = JSON.stringify(input.resources);
        }

        await executor
            .updateTable('journeys')
            .set(updateData)
            .where('guildId', '=', existing.guildId)
            .where('journeyKey', '=', existing.journeyKey)
            .execute();
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
     * an older schema or edited by hand could still be malformed. Every way that shows
     * is raised as {@link MalformedJourneyError}.
     */
    private assertValidDeclaration(row: JourneyEntity): JourneyEntity {
        try {
            if (!Array.isArray(row.resources)) {
                throw new Error('its resources column is not an array.');
            }
            validateJourneyDeclaration(toDeclarationFromRow(row));
        } catch (cause) {
            throw new MalformedJourneyError(row.journeyKey, cause);
        }
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
