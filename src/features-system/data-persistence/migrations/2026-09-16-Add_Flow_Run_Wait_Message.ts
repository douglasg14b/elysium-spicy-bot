import { Kysely } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Let a parked run remember the message whose buttons are holding it.
 *
 * A block that parks by posting controls has a problem no other suspending block
 * has: the controls outlive the park. Once the run moves on, the message is still
 * sitting in the channel with live buttons on it, and nothing stored says which
 * park those buttons belonged to. Two parks at one node are identical in every
 * other column — same `resume_node_id`, same `suspended` status — so a press from
 * the first is indistinguishable from a press from the second, and advances the
 * run again. The message id is the only value that differs between them.
 *
 * It also gives the run somewhere to say *what to disable*: on a choice, a
 * timeout, or a cancellation, the message to edit is the one named here, which is
 * otherwise known only to the process that posted it and lost the moment it exits.
 *
 * **Nullable rather than defaulted**, which is the opposite of the `variables`
 * column beside it and deliberately so. An empty bag is a true statement about a
 * run that recorded nothing, so `{}` is the right default there; here there is no
 * value that means "no message" except the absence of one. A delay parks without
 * posting anything, a gateway wait does too, and so did every row written before
 * this column existed — all three are the same fact, and none of them is rewritten.
 */
const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema.alterTable('flow_runs').addColumn('wait_message_id', 'text').execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.alterTable('flow_runs').dropColumn('wait_message_id').execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema.alterTable('flow_runs').addColumn('wait_message_id', 'text').execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.alterTable('flow_runs').dropColumn('wait_message_id').execute();
        },
    },
};
