/**
 * Telling "this table has not been migrated yet" apart from every other database error.
 *
 * Work that runs on a timer or on every save reads a table that only exists once its
 * migration has run. On an un-migrated database every one of those reads fails, and
 * logging a stack trace per tick or per save buries the one line that says what to do.
 */

/**
 * True only for "this table is not there" from SQLite or Postgres — i.e. the schema
 * has not been migrated yet.
 *
 * Matched on each dialect's exact wording for a missing table — SQLite's `no such
 * table: <table>`, Postgres's `relation "<table>" does not exist` — and nothing
 * looser. A missing *column* from a half-applied migration names the table too on
 * Postgres (`column "x" of relation "<table>" does not exist`), and this predicate
 * decides whether an error is reported at all.
 */
export function isMissingTableError(error: unknown, table: string): boolean {
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();
    // `relation` must open the message (or follow a `: ` prefix) — the column error
    // reads `… of relation "<table>" does not exist`, which a bare substring would match.
    return (
        message.includes(`no such table: ${table}`) ||
        new RegExp(`(?:^|: )relation "${table}" does not exist`).test(message)
    );
}

/** Tables whose absence has been reported in this process. */
const reported = new Set<string>();

/**
 * Say once per process that `table` is missing, what that stops, and how to fix it —
 * however many readers run into it, however often.
 *
 * @param consequence - What does not happen until it is migrated, e.g. "no Schedule
 * trigger fires", worded to follow "so".
 */
export function reportMissingTableOnce(table: string, consequence: string): void {
    if (reported.has(table)) {
        return;
    }
    reported.add(table);
    console.error(
        `[db] The ${table} table does not exist, so ${consequence}. Run \`pnpm migrate:latest:dev\` ` +
            '(or `pnpm migrate:latest`) to apply pending migrations.'
    );
}

/** Forget what was reported, so a test can see it said again. */
export function resetMissingTableReportsForTests(): void {
    reported.clear();
}
