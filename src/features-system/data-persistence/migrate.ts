import { Migrator, MigrationProvider, Migration } from 'kysely';

import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { database } from './database';

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
            const absolutePathToMigration = os.platform() === 'win32'
                ? pathToFileURL(path.join(directoryPath, file)).href
                : path.join(directoryPath, file);

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

    try {
        const { error, results } = await migrator.migrateToLatest();

        if (results?.length === 0) {
            console.log('✅ No migrations needed');
            console.log('🎉 Migrations complete');
            return;
        }

        for (const migrationResult of results ?? []) {
            if (migrationResult.status === 'Success') {
                console.log(`✅ ${migrationResult.direction} ${migrationResult.migrationName}`);
            } else if (migrationResult.status === 'Error') {
                console.error(`❌ ${migrationResult.direction} ${migrationResult.migrationName}`);
            }
        }

        if (error) {
            console.error('Migration failed:', error);
            process.exitCode = 1;
            return;
        }

        console.log('🎉 Migrations complete');
    } finally {
        await database.destroy();
    }
}

void main().catch((error: unknown) => {
    console.error('Unexpected migration failure:', error);
    process.exitCode = 1;
});
