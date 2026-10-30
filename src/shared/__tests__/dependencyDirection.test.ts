import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * That the shared modules many features read — the message model, the button vocabulary,
 * the guild uploads, member names and the per-guild queue — import no product feature.
 *
 * The message model and the uploads are read by Post Embed (flows) and the message resource
 * (provisioning), and provisioning may not import flows (its own
 * `dependencyDirection.test.ts`); member names is read by any page that shows a person. An
 * import from any of these into `src/features/` would
 * typecheck and stay green while quietly making one feature depend on another through them.
 * The rule was held by review alone; this makes it a test.
 *
 * Scanned as text, as provisioning's twin does: importing the modules would pull in the
 * database. Tests count too, since a test importing a feature couples the two just as firmly.
 */

const THIS_FILE = fileURLToPath(import.meta.url);
const SRC_DIR = join(dirname(THIS_FILE), '..', '..');

/** What the rule covers: directories are scanned whole, files on their own. */
const GUARDED_PATHS = [
    join(SRC_DIR, 'shared', 'discordMessage'),
    join(SRC_DIR, 'shared', 'discordButtons.ts'),
    join(SRC_DIR, 'shared', 'resourceKey.ts'),
    join(SRC_DIR, 'features-system', 'guild-uploads'),
    join(SRC_DIR, 'features-system', 'member-names'),
    join(SRC_DIR, 'shared', 'perGuildQueue.ts'),
] as const;

/**
 * Any import specifier that reaches `src/features/`, relative (`../../features/flows/…`, how
 * every intra-`src` import is written) or path-style. Matches the specifier, not the `from`
 * before it, so `import type` and multi-line imports count. `features-system/` does not match:
 * the segment must be exactly `features`.
 */
const FEATURES_IMPORT = /['"](?:[^'"]*\/)?features\/[^'"]*['"]/;

/** Every `.ts` file at `path`: the file itself, or everything under the directory. */
function sourceFilesAt(path: string): string[] {
    if (!statSync(path).isDirectory()) return [path];

    const found: string[] = [];
    for (const entry of readdirSync(path)) {
        const full = join(path, entry);
        if (statSync(full).isDirectory()) {
            found.push(...sourceFilesAt(full));
            continue;
        }
        if (entry.endsWith('.ts')) found.push(full);
    }
    return found;
}

/** Strip comments, so a header describing the rule is not read as breaking it. */
function withoutComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('the shared modules many features read do not depend on a feature', () => {
    const files = GUARDED_PATHS.flatMap(sourceFilesAt);

    it('scans the files it means to', () => {
        // A wrong path would make the assertion below pass by scanning nothing.
        expect(files.some((file) => file.endsWith('buildMessagePayload.ts'))).toBe(true);
        expect(files.some((file) => file.endsWith('discordButtons.ts'))).toBe(true);
        expect(files.some((file) => file.includes('guild-uploads') && file.endsWith('index.ts'))).toBe(true);
        expect(files.some((file) => file.includes('member-names') && file.endsWith('index.ts'))).toBe(true);
        expect(files.length).toBeGreaterThan(15);
    });

    it('imports nothing from src/features', () => {
        const offenders = files.filter((file) => FEATURES_IMPORT.test(withoutComments(readFileSync(file, 'utf8'))));

        expect(offenders).toEqual([]);
    });

    it('tells a feature import from a features-system one', () => {
        expect(FEATURES_IMPORT.test(`import { x } from '../../features/flows/engine';`)).toBe(true);
        expect(FEATURES_IMPORT.test(`import type { X } from '../features/provisioning';`)).toBe(true);
        expect(FEATURES_IMPORT.test(`import { y } from '../../features-system/guild-uploads';`)).toBe(false);
    });
});
