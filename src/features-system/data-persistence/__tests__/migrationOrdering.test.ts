import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Migration filenames must sort in the order they were deployed.
 *
 * Kysely's `Migrator` compares the provider's sorted list against the rows in
 * `kysely_migration` and **throws** if an unexecuted migration sorts before one
 * that has already run — `allowUnorderedMigrations` is not set anywhere in this
 * repository. The throw aborts the whole batch, so `results` comes back
 * `undefined` and *nothing* migrates: one badly-named file stops every later one
 * as well, and `pnpm dev` fails before the bot starts.
 *
 * This gate exists because the flow-runs test helper applies migrations by
 * calling each `up` directly, in an order it hard-codes. That is deliberate — it
 * needs the pre-M1 table on purpose — but it means the helper cannot notice a
 * filename that sorts wrongly, and a suite built on it stays green while the real
 * migrator refuses to run. Slice B shipped exactly that bug and this is what
 * would have caught it.
 *
 * Filesystem order is not relied on: the assertion is that the directory listing
 * and its own lexical sort agree, which is the comparison `Migrator` makes.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Migrations already applied to deployed databases.
 *
 * Appending here is a deliberate act: it asserts that this name is present in
 * `kysely_migration` somewhere real, so nothing new may ever sort before it.
 * A new migration goes at the END of this list, with a name that sorts after the
 * one above it.
 */
const DEPLOYED_IN_ORDER = [
    '2025-08-28-Initial_Create',
    '2025-11-10-Create_Ticketing_Config',
    '2026-01-06-Create_Birthday_Table',
    '2026-04-17-Create_Birthday_Config',
    '2026-05-26-Create_Leveling_Tables',
    '2026-08-17-Add_Leveling_Voice_Xp',
    '2026-09-01-Create_Warnings_Table',
    '2026-09-04-Create_Warnings_Config',
    '2026-09-11-Create_Flows',
    '2026-09-12-Create_Flow_Runs',
    '2026-09-13-Settle_Flow_Run_Lifecycle',
] as const;

/**
 * Every migration key, in the order the migrator will apply them.
 *
 * Sorted explicitly rather than trusting the directory listing: `readdirSync` is
 * alphabetical on NTFS by accident and hash-ordered on ext4, so a gate that
 * leaned on it would pass here and mean nothing on a Linux CI box. `Migrator`
 * sorts the provider's keys, so this is what it actually sees.
 */
function migrationKeys(): string[] {
    return readdirSync(MIGRATIONS_DIR)
        .filter((file) => file.endsWith('.ts'))
        .map((file) => file.slice(0, file.lastIndexOf('.')))
        .sort();
}

describe('migration ordering', () => {
    it('opens with exactly the already-deployed migrations, in their deployed order', () => {
        // One assertion covering every way this can go wrong, because the obvious
        // three separate checks leave a hole between them: comparing new names
        // against only the *newest* deployed one passes a `2026-09-14-Aaa_…` that
        // sorts before an existing `2026-09-14-Add_…`, which is the same bug in a
        // narrower window.
        //
        // Taking the prefix instead means a new migration can only ever appear
        // AFTER the deployed block — which is precisely Kysely's own rule. It also
        // catches a renamed or deleted deployed migration, each of which strands
        // every database that has run it, since the executed row then matches no
        // file at all.
        expect(
            migrationKeys().slice(0, DEPLOYED_IN_ORDER.length),
            'A migration has been added that sorts before one which has already run on deployed ' +
                'databases, or a deployed migration was renamed or removed. Kysely refuses the whole ' +
                'batch in either case — nothing migrates at all and the bot will not start. Give a new ' +
                'migration a name that sorts after every entry in DEPLOYED_IN_ORDER, and append it ' +
                'there once it has been deployed.'
        ).toEqual([...DEPLOYED_IN_ORDER]);
    });

    it('holds nothing but .ts migrations, because the loader has no filter', () => {
        // `FileMigrationProvider` imports every entry it reads. A stray .md or .sql
        // here is imported as a migration and fails at load.
        const strays = readdirSync(MIGRATIONS_DIR).filter((file) => !file.endsWith('.ts'));

        expect(strays).toEqual([]);
    });
});
