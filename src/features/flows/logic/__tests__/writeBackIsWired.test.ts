import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * That write-back actually runs after an install.
 *
 * `bindResourcesToGraph` and `resolveJourneyResources` were both written, exported,
 * typechecked and tested while having **no caller at all** — the second was missed by
 * a first audit and found only when the operator asked what else was unwired. They
 * join `incrementTicketNumber`, `ticketChannelValidation`, `ticketCommands.ts` and
 * `BLOCK_CAPABILITIES` as the fifth and sixth cases in this repo.
 *
 * The chain here is deliberately indirect — provisioning must not import flows, so
 * flows registers a callback — and an indirection is exactly what a typechecker
 * cannot prove is connected. Both ends are asserted as source text: the registration
 * on the flows side, and the call on the provisioning side.
 */

const FEATURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function read(...segments: string[]): string {
    return readFileSync(join(FEATURES, ...segments), 'utf8');
}

/** Every `.ts` file under a directory, tests excluded — they mock the call freely. */
function sourceFilesUnder(directory: string): string[] {
    const found: string[] = [];

    for (const entry of readdirSync(directory)) {
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) {
            if (entry === '__tests__' || entry === 'node_modules') continue;
            found.push(...sourceFilesUnder(full));
            continue;
        }
        if (entry.endsWith('.ts')) found.push(full);
    }

    return found;
}

describe('resource write-back is reachable', () => {
    it('is registered when flows initialise', () => {
        const source = read('flows', 'initFlows.ts');

        expect(source).toMatch(/registerResourceWriteBack\(\s*applyResourcesToFlows\s*\)/);
    });

    /*
     * Asserted against `runInstall.ts` rather than any one caller. That is where the
     * call lives, and it is the shared sequence every surface installs through — since
     * the `/install-journey` Apply button was retired, the dashboard's `POST /install`
     * route is the only one. Checking a caller would pass or fail on its rendering
     * rather than on whether an install writes its ids back at all.
     */
    it('is run after an install', () => {
        const source = read('provisioning', 'logic', 'runInstall.ts');

        expect(source).toMatch(/runResourceWriteBack\(/);
    });

    it('runs after the install, not before it', () => {
        // Writing ids back before the guild is mutated would write the ids that
        // existed *last* time, which is worse than writing none.
        const source = read('provisioning', 'logic', 'runInstall.ts');
        const installIndex = source.indexOf('await installJourney(');
        const writeBackIndex = source.indexOf('runResourceWriteBack(');

        expect(installIndex).toBeGreaterThan(-1);
        expect(writeBackIndex).toBeGreaterThan(installIndex);
    });

    /*
     * Every surface that installs goes through that one sequence.
     *
     * The reason the assertion above could move safely: if a surface stopped calling
     * `runInstall` and inlined its own preview-and-apply, it would silently skip the
     * write-back and every test above would still pass. This is what makes the single
     * path a fact rather than a convention.
     *
     * Stated as a search rather than a list of known files. The Discord Apply button
     * used to be the second entry here and was deleted, leaving the dashboard route
     * alone — and a hardcoded list of one stops being a guarantee about *every* surface
     * the moment someone adds the next one. So the rule is inverted: whatever calls
     * `installJourney` directly must be `runInstall` itself.
     */
    it('is reached by every surface that installs', () => {
        // The dashboard route, which is the only install surface today.
        expect(readFileSync(join(FEATURES, '..', 'web', 'api', 'flowRoutes.ts'), 'utf8')).toMatch(
            /runInstall\(/
        );

        // And nothing else applies a plan behind `runInstall`'s back. `installJourney`
        // is the mutating call; reaching it any other way skips the write-back. Its own
        // module is excluded — that is the declaration, not a caller.
        const DECLARING_MODULE = 'features/provisioning/provisioningService.ts';

        // The call site, plus the import that would let a call site wear another name.
        // Matching only `installJourney(` would miss `import { installJourney as x }`,
        // and "a surface that renamed it" is exactly the surface worth catching.
        const REACHES_INSTALL = /\binstallJourney\s*\(|\binstallJourney\s+as\s+\w+/;

        const callers = sourceFilesUnder(join(FEATURES, '..'))
            .filter((file) => REACHES_INSTALL.test(readFileSync(file, 'utf8')))
            .map((file) => relative(join(FEATURES, '..'), file).replace(/\\/g, '/'))
            .filter((file) => file !== DECLARING_MODULE);

        expect(callers).toEqual(['features/provisioning/logic/runInstall.ts']);
    });
});

/*
 * The dependency direction — provisioning must not import flows — used to be asserted
 * here against a hardcoded list of files, two of which were the deleted Discord command
 * and its Apply button. It is not re-stated in this file, because
 * `provisioning/__tests__/dependencyDirection.test.ts` already owns that rule and owns
 * it better: it scans tests too, matches the import specifier rather than anchoring on
 * `from` (which silently missed multi-line and `import type` forms), and fails loudly if
 * its own sweep ever stops finding files. Two sweeps of one directory would drift.
 */
