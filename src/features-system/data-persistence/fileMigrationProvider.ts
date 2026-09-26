import type { Migration, MigrationProvider } from 'kysely';

import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

// ⚠ Typical JS-ecosystem bullshit below ⚠
// ========================================
// NOTE: Kysely's built-in `FileMigrationProvider` does not work on Windows,
// due to Windows not supporting `import()` of absolute URLs which are not
// file URLs. Kysely has decided not to fix this issue since they don't want
// to have any platform-specific code in their library, so we have to fix it
// ourselves. You can reference the original implementation here:
// https://github.com/kysely-org/kysely/blob/0.27.2/src/migration/file-migration-provider.ts
//
// Its own module rather than inside `migrate.ts`, because that file is a script: importing
// it runs every migration and then destroys the database. Tests that need the real schema
// build it with this provider instead of copying migrations by hand.

export class FileMigrationProvider implements MigrationProvider {
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
