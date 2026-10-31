import { database, type DatabaseClient } from '../../data-persistence/database';
import { mergeNicknames } from '../logic/mergeNicknames';
import type { MemberNameRow } from './memberNamesSchema';

/** An account as Discord describes it, in every server alike. */
export interface SeenUser {
    readonly userId: string;
    readonly username: string;
    readonly globalName: string | null;
    readonly isBot: boolean;
}

/** A member as seen in one server: the account, and their nickname there. */
export interface SeenMember extends SeenUser {
    readonly nickname: string | null;
}

/**
 * Rows per statement. Eleven values a row keeps one batch well inside both dialects' limits
 * on bound values, and a sweep of a large server to a statement per hundred members.
 */
const WRITE_BATCH_SIZE = 100;

/**
 * One entry per user, the last given. A multi-row upsert naming one row twice fails on
 * Postgres ("cannot affect row a second time") where sqlite quietly keeps the last, so the
 * repo makes the two agree rather than leave it to every caller.
 */
function lastPerUser<Seen extends SeenUser>(seen: readonly Seen[]): Seen[] {
    return [...new Map(seen.map((entry) => [entry.userId, entry])).values()];
}

function batchesOf<Item>(items: readonly Item[]): Item[][] {
    const batches: Item[][] = [];
    for (let offset = 0; offset < items.length; offset += WRITE_BATCH_SIZE) {
        batches.push(items.slice(offset, offset + WRITE_BATCH_SIZE));
    }
    return batches;
}

/**
 * Persistence for who each id is in each server. SQL lives here and nowhere else.
 *
 * **Not safe to call concurrently for one guild.** {@link recordPresent} reads each row's
 * nicknames, merges in JS and writes them back — never a dialect's JSON operators, which
 * differ between sqlite and postgres — so two calls for one guild at once could each drop
 * the other's nickname. Every writer goes through member-names' per-guild queue
 * (`memberNamesQueue.ts`), which is what makes the read-merge-write safe.
 */
export class MemberNamesRepo {
    constructor(private readonly db: DatabaseClient = database) {}

    /** The rows this guild holds for these ids, in no particular order. An id with none is absent. */
    async findByUserIds(guildId: string, userIds: readonly string[]): Promise<MemberNameRow[]> {
        if (userIds.length === 0) return [];
        const rows: MemberNameRow[] = [];
        for (const batch of batchesOf(userIds)) {
            rows.push(
                ...(await this.db
                    .selectFrom('member_names')
                    .selectAll()
                    .where('guildId', '=', guildId)
                    .where('userId', 'in', batch)
                    .execute())
            );
        }
        return rows;
    }

    /**
     * Record members as in the server now: their names, their nickname merged into the ones
     * seen before, `inServer` true and any `leftAt` cleared. One read and one write per
     * {@link WRITE_BATCH_SIZE} members.
     *
     * `unlessWrittenSince` is for a writer holding members read a while ago — the startup
     * sweep's member list, a dashboard lookup's cached members: a row written at or after it
     * was written by something newer — a leave or an update heard meanwhile — and is left as
     * it is. Except a row only ever looked up (not in the server, no leave heard): a lookup
     * says nothing about presence, so the member seen here wins over it.
     */
    async recordPresent(
        guildId: string,
        members: readonly SeenMember[],
        unlessWrittenSince?: Date
    ): Promise<void> {
        for (const batch of batchesOf(lastPerUser(members))) {
            const stored = await this.db
                .selectFrom('member_names')
                .select(['userId', 'nicknames'])
                .where('guildId', '=', guildId)
                .where(
                    'userId',
                    'in',
                    batch.map((member) => member.userId)
                )
                .execute();
            const storedNicknames = new Map(stored.map((row) => [row.userId, row.nicknames]));

            const now = new Date().toISOString();
            const rows = batch.map((member) => ({
                guildId,
                userId: member.userId,
                username: member.username,
                globalName: member.globalName,
                nickname: member.nickname,
                nicknames: JSON.stringify(mergeNicknames(storedNicknames.get(member.userId) ?? [], member.nickname)),
                isBot: member.isBot,
                inServer: true,
                leftAt: null,
                firstSeenAt: now,
                updatedAt: now,
            }));

            await this.db
                .insertInto('member_names')
                .values(rows)
                .onConflict((conflict) => {
                    const update = conflict.columns(['guildId', 'userId']).doUpdateSet((eb) => ({
                        username: eb.ref('excluded.username'),
                        globalName: eb.ref('excluded.globalName'),
                        nickname: eb.ref('excluded.nickname'),
                        nicknames: eb.ref('excluded.nicknames'),
                        isBot: eb.ref('excluded.isBot'),
                        inServer: eb.ref('excluded.inServer'),
                        leftAt: eb.ref('excluded.leftAt'),
                        updatedAt: eb.ref('excluded.updatedAt'),
                    }));
                    if (!unlessWrittenSince) return update;
                    return update.where((eb) =>
                        eb.or([
                            // An ISO string, not the Date the other two guards bind: Kysely types a
                            // column inside ON CONFLICT by its write type (string), and refuses a
                            // Date there. Both bind the same value — the sqlite plugin writes a Date
                            // as this very string, and Postgres reads it as the same timestamptz.
                            eb('member_names.updatedAt', '<', unlessWrittenSince.toISOString()),
                            eb.and([eb('member_names.inServer', '=', false), eb('member_names.leftAt', 'is', null)]),
                        ])
                    );
                })
                .execute();
        }
    }

    /**
     * Record accounts looked up from Discord because nobody had seen them here: not in the
     * server (a lookup cannot say when they left, so no `leftAt`), no nickname. A row that
     * appeared meanwhile is newer than the lookup and is kept.
     */
    async recordLookedUp(guildId: string, users: readonly SeenUser[]): Promise<void> {
        const now = new Date().toISOString();
        for (const batch of batchesOf(lastPerUser(users))) {
            await this.db
                .insertInto('member_names')
                .values(
                    batch.map((user) => ({
                        guildId,
                        userId: user.userId,
                        username: user.username,
                        globalName: user.globalName,
                        nickname: null,
                        nicknames: JSON.stringify([]),
                        isBot: user.isBot,
                        inServer: false,
                        leftAt: null,
                        firstSeenAt: now,
                        updatedAt: now,
                    }))
                )
                .onConflict((conflict) => conflict.columns(['guildId', 'userId']).doNothing())
                .execute();
        }
    }

    /**
     * Record a leave the bot heard: `inServer` false and `leftAt` set, the stored names kept.
     * Somebody it never recorded is recorded as they left, from what the leave carried.
     */
    async recordLeft(guildId: string, member: SeenMember, leftAt: Date): Promise<void> {
        const at = leftAt.toISOString();
        await this.db
            .insertInto('member_names')
            .values({
                guildId,
                userId: member.userId,
                username: member.username,
                globalName: member.globalName,
                nickname: member.nickname,
                nicknames: JSON.stringify(mergeNicknames([], member.nickname)),
                isBot: member.isBot,
                inServer: false,
                leftAt: at,
                firstSeenAt: at,
                updatedAt: at,
            })
            .onConflict((conflict) =>
                conflict.columns(['guildId', 'userId']).doUpdateSet({ inServer: false, leftAt: at, updatedAt: at })
            )
            .execute();
    }

    /**
     * After a startup sweep: everyone recorded as in the server whom the sweep did not find
     * is marked as not in it, with no `leftAt` — the bot did not see them go. A row written
     * at or after `unlessWrittenSince` is newer than the sweep's list (a join heard while it
     * was fetched) and is left alone. Returns how many rows it marked.
     *
     * Diffed in JS rather than with `NOT IN (…)`, which on a large server would pass
     * sqlite's limit on bound values.
     */
    async markMissingAsGone(guildId: string, foundIds: ReadonlySet<string>, unlessWrittenSince: Date): Promise<number> {
        const recorded = await this.db
            .selectFrom('member_names')
            .select('userId')
            .where('guildId', '=', guildId)
            .where('inServer', '=', true)
            .where('updatedAt', '<', unlessWrittenSince)
            .execute();
        const missing = recorded.map((row) => row.userId).filter((userId) => !foundIds.has(userId));

        const now = new Date().toISOString();
        for (const batch of batchesOf(missing)) {
            await this.db
                .updateTable('member_names')
                .set({ inServer: false, updatedAt: now })
                .where('guildId', '=', guildId)
                .where('userId', 'in', batch)
                .where('updatedAt', '<', unlessWrittenSince)
                .execute();
        }
        return missing.length;
    }

    /** The guilds holding a row for this account. */
    async guildIdsFor(userId: string): Promise<string[]> {
        const rows = await this.db.selectFrom('member_names').select('guildId').where('userId', '=', userId).execute();
        return rows.map((row) => row.guildId);
    }

    /**
     * An account's names changed: its row in this guild takes them. Nicknames are the guild's
     * own and stay. `updatedAt` stays too: the sweep's guard reads it as "something newer
     * about who is in the server", which a rename is not.
     */
    async recordUser(guildId: string, user: SeenUser): Promise<void> {
        await this.db
            .updateTable('member_names')
            .set({
                username: user.username,
                globalName: user.globalName,
                isBot: user.isBot,
            })
            .where('guildId', '=', guildId)
            .where('userId', '=', user.userId)
            .execute();
    }
}

export const memberNamesRepo = new MemberNamesRepo();
