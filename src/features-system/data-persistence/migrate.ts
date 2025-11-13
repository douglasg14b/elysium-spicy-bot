import { Migrator, MigrationProvider, Migration } from 'kysely';

import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { database } from './database';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ⚠ Typical JS-ecosystem bullshit below ⚠
// ========================================
// NOTE: Kysely's built-in `FileMigrationProvider` does not work on Windows,
// due to Windows not supporting `import()` of absolute URLs which are not
// file URLs. Kysely has decided not to fix this issue since they don't want
// to have any platform-specific code in their library, so we have to fix it
// ourselves. You can reference the original implementation here:
// https://github.com/kysely-org/kysely/blob/0.27.2/src/migration/file-migration-provider.ts

class FileMigrationProvider implements MigrationProvider {
    async getMigrations() {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);

        // This is the absolute path to the "migrations" directory.
        const directoryPath = path.join(__dirname, 'migrations');

        // This is a list of file names in the "migrations" directory.
        const files = await fs.readdir(directoryPath);

        const migrations: Record<string, Migration> = {};

        for (const file of files) {
            const pathParts = [directoryPath, file];

            // This is the main addition we're making to the original code from
            // Kysely. On Windows, we need all absolute URLs to be "file URLs", so
            // we add this prefix.
            if (os.platform() === 'win32') {
                pathParts.unshift('file://');
            }

            const absolutePathToMigration = path.join(...pathParts);

            const migration = await import(absolutePathToMigration);

            // We remove the extension form the file name to get the migration key.
            const migrationKey = file.substring(0, file.lastIndexOf('.'));

            migrations[migrationKey] = migration;
        }

        return migrations;
    }
}

const migrator = new Migrator({
    db: database,
    provider: new FileMigrationProvider(),
});

async function main() {
    console.log('🚀 Running migrations...');

    const { error, results } = await migrator.migrateToLatest();

    if (results?.length === 0) {
        console.log('✅ No migrations needed');
        await database.destroy();
        console.log('🎉 Migrations complete');
        return;
    }

    for (const r of results ?? []) {
        if (r.status === 'Success') {
            console.log(`✅ ${r.direction} ${r.migrationName}`);
        } else if (r.status === 'Error') {
            console.error(`❌ ${r.direction} ${r.migrationName}`);
        }
    }

    if (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }

    await database.destroy();
    console.log('🎉 Migrations complete');
}

main();
