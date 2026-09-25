import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * That leveling never imports the flow engine.
 *
 * Leveling is a base capability, like provisioning: flows consume it, and the dependency
 * runs one way. Modelled on `src/features/provisioning/__tests__/dependencyDirection.test.ts`,
 * which exists because that rule was written in three plan documents and believed to be
 * enforced by a test that did not exist — it held only because nobody had broken it yet.
 *
 * An inverted import does not fail loudly. It typechecks, the suite stays green, and the
 * cost arrives later as a cycle: `initFlows` imports leveling to register its subscriber,
 * so an import back would close the loop.
 *
 * Scanned as text rather than by importing: importing the feature would pull in the
 * Discord client and the database, which a unit test must not do.
 */

const THIS_FILE = fileURLToPath(import.meta.url);
const LEVELING_DIR = join(dirname(THIS_FILE), '..');

/**
 * Any import specifier that reaches the flows feature.
 *
 * Matches the **specifier**, not the `from` keyword before it: `import type { X } from
 * '…'` and a multi-line import both put arbitrary tokens in between.
 *
 * Two shapes, because both occur in this repo and only the first is obvious:
 *   - `../../flows/…`   — relative, how every intra-`src` import is actually written
 *   - `…features/flows` — path-style, as the rule is usually stated in prose
 */
const FLOWS_IMPORT = /['"][^'"]*(?:\.\.\/flows\/|features\/flows)[^'"]*['"]/;

/**
 * Every `.ts` file under leveling — tests included, since a test importing the engine
 * couples the two features just as firmly as production code would.
 *
 * This file is the one exclusion, and it has to be: it necessarily contains the forbidden
 * path, in a test name and in the pattern itself.
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
 * Strip comments so the barrel's own header — which *describes* the rule and names the
 * forbidden path doing it — is not mistaken for a violation of it.
 */
function withoutComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('leveling does not depend on the flow engine', () => {
    const files = sourceFilesIn(LEVELING_DIR);

    it('scans the files it means to', () => {
        // Without this, a broken path walk would make the assertion below pass by
        // scanning nothing at all — the way this rule went unguarded in provisioning.
        expect(files.length).toBeGreaterThan(15);
        expect(files.some((file) => file.endsWith('levelingService.ts'))).toBe(true);
        expect(files.some((file) => file.endsWith('awardFlowXp.ts'))).toBe(true);
    });

    it('imports nothing from src/features/flows', () => {
        const offenders = files.filter((file) =>
            FLOWS_IMPORT.test(withoutComments(readFileSync(file, 'utf8')))
        );

        expect(offenders).toEqual([]);
    });

    it('keeps the level-up seam, which is how the two features are allowed to meet', () => {
        // The seam is the sanctioned alternative to the import this file forbids: flows
        // registers a subscriber, leveling notifies whatever registered knowing nothing
        // about who did. Deleting it would leave a correct rule and no way to obey it.
        const seam = readFileSync(join(LEVELING_DIR, 'levelUpSubscribers.ts'), 'utf8');

        expect(seam).toMatch(/export function registerLevelUpSubscriber/);
        expect(seam).toMatch(/export async function notifyLevelUp/);
    });
});
