import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import { database, type Database, type DatabaseClient } from '../../../features-system/data-persistence/database';
import type { WarningStatus } from '../logic/warningStatus';
import type { NewWarning, Warning, WarningActor } from './warningsSchema';

export type ActiveWarningMemberSummary = {
    userId: string;
    warningCount: number;
    soonestExpiresAt: Date;
};

/**
 * How many warnings the dashboard's list returns at most. {@link WarningsRepo.listByGuild}
 * reads one more, so the route can tell "exactly the cap" from "more than it" and report
 * `truncated` — the tickets list's arrangement (`TICKET_LIST_CAP`).
 */
export const WARNING_LIST_CAP = 200;

/** The dashboard list's filters. Each absent one means "all". */
export type WarningListFilter = {
    readonly status?: WarningStatus;
    readonly userId?: string;
    /** A prefix of the slug, the rule, or either recorded name. Case-insensitive. */
    readonly search?: string;
};

export type WarningCounts = Readonly<Record<WarningStatus, number>>;

/** The columns an edit writes. The issued date is not here: everything else hangs off it. */
export type WarningEditColumns = {
    readonly rule: string;
    readonly description: string;
    /** The drop-off, as the UTC-midnight ISO string the table stores. */
    readonly expiresAt: string;
};

/** The row as the edit read it — its editable columns and its last edit — which it must still be for the edit to land. */
export type WarningEditBase = Pick<Warning, 'rule' | 'description' | 'expiresAt' | 'editedAt'>;

/** The columns a search matches a prefix of. */
type SearchableColumn = 'slug' | 'rule' | 'userName' | 'issuerName';
const SEARCHABLE_COLUMNS: readonly SearchableColumn[] = ['slug', 'rule', 'userName', 'issuerName'];

function coerceSqlDate(value: string | Date): Date {
    return value instanceof Date ? value : new Date(value);
}

/**
 * The SQL statement of each status — `logic/warningStatus.ts`'s rule, and the only other
 * place it is written. `asOf` is "today" as the table stores dates: the Pacific calendar day
 * at UTC midnight (`getActiveAsOfUtcMidnight`), so a warning dropping off today is active.
 */
function statusPredicate(
    eb: ExpressionBuilder<Database, 'warnings'>,
    status: WarningStatus,
    asOf: Date
): Expression<SqlBool> {
    switch (status) {
        case 'released':
            return eb('clearedAt', 'is not', null);
        case 'expired':
            return eb.and([eb('clearedAt', 'is', null), eb('expiresAt', '<', asOf)]);
        case 'active':
            return eb.and([eb('clearedAt', 'is', null), eb('expiresAt', '>=', asOf)]);
    }
}

export class WarningsRepo {
    constructor(private readonly db: DatabaseClient = database) {}

    async getByGuildAndSlug(guildId: string, slug: string): Promise<Warning | null> {
        const warning = await this.db
            .selectFrom('warnings')
            .selectAll()
            .where('guildId', '=', guildId)
            .where('slug', '=', slug)
            .executeTakeFirst();

        return warning ?? null;
    }

    async insert(warning: NewWarning): Promise<Warning> {
        await this.db.insertInto('warnings').values(warning).execute();

        const created = await this.getByGuildAndSlug(warning.guildId, warning.slug);
        if (!created) {
            throw new Error(`Warning insert succeeded but row was not found for slug ${warning.slug}`);
        }

        return created;
    }

    async listActive(
        guildId: string,
        asOf: Date,
        options: { limit: number; userId?: string }
    ): Promise<Warning[]> {
        let query = this.db
            .selectFrom('warnings')
            .selectAll()
            .where('guildId', '=', guildId)
            .where((eb) => statusPredicate(eb, 'active', asOf));

        if (options.userId) {
            query = query.where('userId', '=', options.userId);
        }

        return query.orderBy('expiresAt', 'asc').orderBy('id', 'asc').limit(options.limit).execute();
    }

    async countActive(guildId: string, asOf: Date, userId?: string): Promise<number> {
        let query = this.db
            .selectFrom('warnings')
            .select((eb) => eb.fn.countAll<number>().as('count'))
            .where('guildId', '=', guildId)
            .where((eb) => statusPredicate(eb, 'active', asOf));

        if (userId) {
            query = query.where('userId', '=', userId);
        }

        const result = await query.executeTakeFirstOrThrow();
        return Number(result.count);
    }

    async listActiveMemberSummaries(
        guildId: string,
        asOf: Date,
        limit: number
    ): Promise<ActiveWarningMemberSummary[]> {
        const rows = await this.db
            .selectFrom('warnings')
            .select((eb) => [
                'userId',
                eb.fn.countAll<number>().as('warningCount'),
                eb.fn.min<Date>('expiresAt').as('soonestExpiresAt'),
            ])
            .where('guildId', '=', guildId)
            .where((eb) => statusPredicate(eb, 'active', asOf))
            .groupBy('userId')
            .orderBy((eb) => eb.fn.countAll(), 'desc')
            .orderBy((eb) => eb.fn.min('expiresAt'), 'asc')
            .limit(limit)
            .execute();

        return rows.map((row) => ({
            userId: row.userId,
            warningCount: Number(row.warningCount),
            soonestExpiresAt: coerceSqlDate(row.soonestExpiresAt),
        }));
    }

    async countActiveMembers(guildId: string, asOf: Date): Promise<number> {
        const result = await this.db
            .selectFrom('warnings')
            .select((eb) => eb.fn.count<number>('userId').distinct().as('count'))
            .where('guildId', '=', guildId)
            .where((eb) => statusPredicate(eb, 'active', asOf))
            .executeTakeFirstOrThrow();

        return Number(result.count);
    }

    /**
     * The guild's warnings for the dashboard, newest issued first (then newest written, as
     * many share an issued day). **Reads {@link WARNING_LIST_CAP} + 1** so the route can
     * report `truncated` without a second count.
     *
     * `search` matches the start of the slug, the rule, or either recorded name,
     * case-insensitively — the names being the snapshots, so a row from before they were
     * recorded is found by slug or rule only. `%`, `_` and `\` are escaped before they become
     * a pattern, with `\` declared as the escape character because SQLite has no default
     * one, and bound rather than written inline (`ticketsRepo.searchByGuild` says why).
     */
    async listByGuild(guildId: string, asOf: Date, filter: WarningListFilter): Promise<Warning[]> {
        let query = this.db.selectFrom('warnings').selectAll().where('guildId', '=', guildId);

        const { status, userId } = filter;
        if (status) {
            query = query.where((eb) => statusPredicate(eb, status, asOf));
        }

        if (userId) {
            query = query.where('userId', '=', userId);
        }

        const search = filter.search?.trim();
        if (search) {
            const escaped = search.replace(/[\\%_]/g, (match) => `\\${match}`);
            const prefix = `${escaped}%`;
            // Both sides lowered in SQL, so each dialect folds them alike: SQLite's `lower`
            // folds ASCII only, and a JS-lowered `É` would never meet a SQLite-lowered one.
            query = query.where((eb) =>
                eb.or(
                    SEARCHABLE_COLUMNS.map(
                        (column) => sql<boolean>`lower(${sql.ref(column)}) like lower(${prefix}) escape ${'\\'}`
                    )
                )
            );
        }

        return query
            .orderBy('issuedAt', 'desc')
            .orderBy('id', 'desc')
            .limit(WARNING_LIST_CAP + 1)
            .execute();
    }

    /** The guild's totals per status, whatever the list is filtered to. */
    async countsByGuild(guildId: string, asOf: Date): Promise<WarningCounts> {
        const row = await this.db
            .selectFrom('warnings')
            .select((eb) => [
                eb.fn
                    .count<string | number>(eb.case().when(statusPredicate(eb, 'active', asOf)).then(eb.ref('id')).end())
                    .as('active'),
                eb.fn
                    .count<string | number>(eb.case().when(statusPredicate(eb, 'expired', asOf)).then(eb.ref('id')).end())
                    .as('expired'),
                eb.fn
                    .count<string | number>(
                        eb.case().when(statusPredicate(eb, 'released', asOf)).then(eb.ref('id')).end()
                    )
                    .as('released'),
            ])
            .where('guildId', '=', guildId)
            .executeTakeFirstOrThrow();

        // `count` arrives as a string on Postgres and a number on SQLite.
        return {
            active: Number(row.active),
            expired: Number(row.expired),
            released: Number(row.released),
        };
    }

    /** Release a warning, recording who and why. Only an unreleased one; returns whether a row changed. */
    async softClear(
        guildId: string,
        slug: string,
        clearedBy: WarningActor,
        reason: string,
        clearedAtIso: string
    ): Promise<boolean> {
        const result = await this.db
            .updateTable('warnings')
            .set({
                clearedAt: clearedAtIso,
                clearedById: clearedBy.id,
                clearedByName: clearedBy.name,
                clearReason: reason,
            })
            .where('guildId', '=', guildId)
            .where('slug', '=', slug)
            .where('clearedAt', 'is', null)
            .execute();

        return result.some((updateResult) => Number(updateResult.numUpdatedRows) > 0);
    }

    /**
     * Change a warning's rule, description and drop-off, recording who edited it and when.
     *
     * Conditional, in the statement itself, on the row being **unreleased** and still
     * holding the values the edit was computed from (`base`). A release landing between the
     * read and this write changes nothing rather than editing a closed record; so does
     * another edit, rather than being silently reverted — and the edited notice's "before"
     * stays true. Returns whether a row changed.
     */
    async updateEditable(
        guildId: string,
        slug: string,
        base: WarningEditBase,
        fields: WarningEditColumns,
        editedBy: WarningActor,
        editedAtIso: string
    ): Promise<boolean> {
        const result = await this.db
            .updateTable('warnings')
            .set({
                rule: fields.rule,
                description: fields.description,
                expiresAt: fields.expiresAt,
                editedAt: editedAtIso,
                editedById: editedBy.id,
                editedByName: editedBy.name,
            })
            .where('guildId', '=', guildId)
            .where('slug', '=', slug)
            .where('clearedAt', 'is', null)
            .where('rule', '=', base.rule)
            .where('description', '=', base.description)
            .where('expiresAt', '=', base.expiresAt)
            .where((eb) => (base.editedAt ? eb('editedAt', '=', base.editedAt) : eb('editedAt', 'is', null)))
            .execute();

        return result.some((updateResult) => Number(updateResult.numUpdatedRows) > 0);
    }
}

export const warningsRepo = new WarningsRepo();
