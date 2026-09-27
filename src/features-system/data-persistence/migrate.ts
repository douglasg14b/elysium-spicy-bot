import { Migrator } from 'kysely';

import { database } from './database';
// The Windows file-URL fix lives there; see its header before changing how migrations load.
import { FileMigrationProvider } from './fileMigrationProvider';

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
