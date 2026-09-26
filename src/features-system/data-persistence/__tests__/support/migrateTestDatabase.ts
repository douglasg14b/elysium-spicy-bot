import { Migrator } from 'kysely';
import { DB_TYPE, SQLITE_DB_PATH } from '../../../../environment';
import { database } from '../../database';
import { FileMigrationProvider } from '../../fileMigrationProvider';

/**
 * Bring the real `database` singleton to the latest schema, for a test that exercises the
 * whole app rather than one table.
 *
 * Every migration runs through the same provider `pnpm migrate:latest` uses, onto the same
 * client with the same plugin stack production uses. There is no copied DDL and no list of
 * migrations to keep up to date, which is what `provisioningTestDb` and `flowRunsTestDb`
 * have to do because they build one table apiece.
 *
 * `vitest.setup.ts` points the singleton at `:memory:`, and Vitest gives each test file
 * its own module registry, so each file gets its own empty database. **Anything else is
 * refused.** A shell exporting a real `SQLITE_DB_PATH` would otherwise have a test
 * migrate, and then write rows into, somebody's actual database.
 */
export async function migrateTestDatabase(): Promise<void> {
    if (DB_TYPE !== 'sqlite' || SQLITE_DB_PATH !== ':memory:') {
        throw new Error(
            `migrateTestDatabase only runs against in-memory SQLite, but DB_TYPE is "${DB_TYPE}" ` +
                `and SQLITE_DB_PATH is "${SQLITE_DB_PATH ?? ''}". Unset both before running this ` +
                'suite; vitest.setup.ts supplies the in-memory defaults.'
        );
    }

    const { error, results } = await new Migrator({
        db: database,
        provider: new FileMigrationProvider(),
    }).migrateToLatest();

    if (error) {
        const failed = results?.find((result) => result.status === 'Error')?.migrationName;
        throw new Error(`Migration ${failed ?? '(unknown)'} failed on the test database.`, {
            cause: error,
        });
    }
}
