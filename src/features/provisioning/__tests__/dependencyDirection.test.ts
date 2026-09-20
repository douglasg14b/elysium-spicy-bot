import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * That provisioning never imports the flow engine.
 *
 * Provisioning is a base capability, like ticketing: flows consume it, and the
 * dependency runs one way. The rule was written down in the feature barrel's header
 * comment and in three plan documents, and was believed to be enforced by a test —
 * which did not exist. It held only because nobody had broken it yet.
 *
 * An inverted import does not fail loudly. It typechecks, the suite stays green, and
 * the cost arrives later as a cycle, or as provisioning being unusable by anything
 * that is not flows. Asserting the direction is what makes the rule real, and it is
 * cheap enough that there was never a reason not to.
 *
 * Scanned as text rather than by importing: importing the feature would pull in the
 * Discord client and the database, which a unit test must not do.
 */

const THIS_FILE = fileURLToPath(import.meta.url);
const PROVISIONING_DIR = join(dirname(THIS_FILE), '..');

/**
 * Any import specifier that reaches the flows feature.
 *
 * Matches the **specifier**, not the `from` keyword before it: `import type { X }
 * from '…'` and a multi-line import both put arbitrary tokens in between, and an
 * earlier version of this pattern anchored on `from` and silently matched neither.
 *
 * Two shapes, because both occur in this repo and only the first is obvious:
 *   - `../../flows/…`   — relative, how every intra-`src` import is actually written
 *   - `…features/flows` — path-style, as the rule is usually stated in prose
 *
 * The relative form is the one that matters. A missing `features/` in the pattern
 * makes this whole file pass while the violation sits three lines above it.
 */
const FLOWS_IMPORT = /['"][^'"]*(?:\.\.\/flows\/|features\/flows)[^'"]*['"]/;

/**
 * Every `.ts` file under provisioning — tests included, since a test importing the
 * engine couples the two features just as firmly as production code would.
 *
 * This file is the one exclusion, and it has to be: it necessarily contains the
 * forbidden path, in a test name and in the pattern itself, so scanning itself makes
 * it report a violation that is only ever its own description of the rule.
 */
function sourceFilesIn(directory: string): string[] {
    const found: string[] = [];

    for (const entry of readdirSync(directory)) {
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) {
            found.push(...sourceFilesIn(full));
            continue;
        }
        if (entry.endsWith('.ts') && full !== THIS_FILE) found.push(full);
    }

    return found;
}

/**
 * Strip comments so the barrel's own header — which *describes* the rule and names
 * the forbidden path doing it — is not mistaken for a violation of it.
 */
function withoutComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('provisioning does not depend on the flow engine', () => {
    const files = sourceFilesIn(PROVISIONING_DIR);

    it('scans the files it means to', () => {
        // Without this, a broken path glob would make the assertion below pass by
        // scanning nothing at all — the way this rule went unguarded in the first place.
        expect(files.length).toBeGreaterThan(15);
        expect(files.some((file) => file.endsWith('provisioningService.ts'))).toBe(true);
        expect(files.some((file) => file.endsWith('applyInstallPlan.ts'))).toBe(true);
    });

    it('imports nothing from src/features/flows', () => {
        const offenders = files.filter((file) =>
            FLOWS_IMPORT.test(withoutComments(readFileSync(file, 'utf8')))
        );

        expect(offenders).toEqual([]);
    });

    it('keeps the write-back seam, which is how the two features are allowed to meet', () => {
        // The seam is the sanctioned alternative to the import this file forbids:
        // flows registers a callback, provisioning calls it knowing nothing about who
        // registered. Deleting it would leave a correct rule and no way to obey it.
        const seam = readFileSync(join(PROVISIONING_DIR, 'resourceWriteBack.ts'), 'utf8');

        expect(seam).toMatch(/export function registerResourceWriteBack/);
        expect(seam).toMatch(/export async function runResourceWriteBack/);
    });
});
