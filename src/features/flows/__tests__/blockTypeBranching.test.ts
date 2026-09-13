/**
 * The two gates that keep the block catalogue from growing a second copy.
 *
 * M1's whole claim is that adding a block means adding one directory under
 * `blocks/`. That claim survives exactly as long as nothing outside a block's own
 * directory names that block. Before M1 three places did — the executor switched on
 * type, the browser held per-type emoji/description/summary catalogues, and the
 * inspector had a twelve-case switch — and all three drifted from the manifests,
 * because nothing made them agree.
 *
 * Two checks, because one does not imply the other:
 *
 * 1. **Type branching** — no file outside `blocks/<block>/` names a block's type or
 *    imports its module. Catches the copy that spreads: a new `switch (node.type)`.
 *    Both halves are needed, and the import half was added after review: the literal
 *    check alone is defeated by the idiom this codebase already blesses, importing a
 *    block's exported type constant and switching on that.
 * 2. **The export list of `nodeMeta.ts`** — pinned exactly. Catches the copy that
 *    *returns*: the browser's catalogues were all exported, so nothing about an
 *    unused symbol would flag them, and deleting them is only permanent if their
 *    reappearance fails something.
 *
 * The one-directory claim is qualified by {@link DECLARED_BLOCK_DEPENDENTS}, which
 * is the honest statement of where it does not yet hold.
 *
 * Both read their targets **as text**, deliberately. The root `tsconfig.json`
 * excludes `web/`, so no type-level check can reach the browser files at all, and a
 * check that ran only over `src/` would miss the tree that actually had the problem.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ensureBlocksDiscovered, listBlockDefinitions } from '../blocks/registry';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const BLOCKS_DIR = join(REPO_ROOT, 'src', 'features', 'flows', 'blocks');

/** Trees the type-branching gate walks, both of which held a copy before M1. */
const SCANNED_TREES = [
    join(REPO_ROOT, 'src', 'features', 'flows'),
    join(REPO_ROOT, 'src', 'web'),
    join(REPO_ROOT, 'web', 'src'),
];

const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

function collectSourceFiles(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            found.push(...collectSourceFiles(full));
            continue;
        }
        if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
            found.push(full);
        }
    }
    return found;
}

/**
 * A block's own directory may name its own type; that is where the name belongs.
 *
 * Scoped to the *owning* directory rather than to `blocks/` as a whole, so one block
 * hardcoding another block's type still fails — that is a cross-block dependency,
 * which is the thing the one-directory claim rules out. Proven: an early draft asked
 * only whether the owning `index.ts` contained the type string at all, which handed
 * every block a pass on every type it mentioned, and a deliberate cross-block
 * reference went undetected until it was tried.
 */
function owningBlockDirectory(file: string): string | undefined {
    if (!file.startsWith(BLOCKS_DIR + sep)) return undefined;
    const [directory] = relative(BLOCKS_DIR, file).split(sep);
    return directory;
}

/**
 * Directory name → the single block type declared inside it.
 *
 * Built by asking each block's own module which directory it came from, rather than
 * by deriving the type from the directory name: the two are similar by convention
 * (`actionAssignRole` / `action.assignRole`) but nothing enforces that, and a gate
 * that assumed it would silently stop covering any block that broke it.
 */
function declaredTypeByDirectory(types: readonly string[]): Map<string, string> {
    const byDirectory = new Map<string, string>();
    for (const directory of readdirSync(BLOCKS_DIR)) {
        const entry = join(BLOCKS_DIR, directory, 'index.ts');
        let source: string;
        try {
            source = readFileSync(entry, 'utf8');
        } catch {
            continue; // A contract file, not a block directory.
        }
        // The `type:` member of the manifest, which is the one that makes the claim.
        // Searched from `BlockManifest` onward so a `type:` in an unrelated annotation
        // above it cannot be picked up instead, and both quote styles are accepted.
        const manifestAt = source.indexOf('BlockManifest');
        const body = manifestAt === -1 ? source : source.slice(manifestAt);
        const declared = /^\s*type:\s*([A-Za-z_][A-Za-z0-9_]*|'[^']+'|"[^"]+")\s*,/m.exec(body)?.[1];
        if (!declared) continue;
        const quoted = declared.startsWith("'") || declared.startsWith('"');
        const resolved = quoted
            ? declared.slice(1, -1)
            : new RegExp(`${declared}\\s*=\\s*['"]([^'"]+)['"]`).exec(source)?.[1];
        if (resolved && types.includes(resolved)) byDirectory.set(directory, resolved);
    }
    return byDirectory;
}

/**
 * Test fixtures deliberately contain block types — including malformed ones — and
 * the engine's own tests build graphs out of real block types to exercise it. Both
 * are legitimate: a test naming a block is not a second catalogue.
 */
function isTestFile(file: string): boolean {
    return file.includes(`${sep}__tests__${sep}`) || file.endsWith('.test.ts') || file.endsWith('.test.tsx');
}

/**
 * Comments are blanked before matching, so this gate reports what the code *does*,
 * not what the prose *mentions*.
 *
 * Deliberate, and it cost a real finding to decide: the first run of this gate
 * flagged a JSDoc line in `flowGraph.ts` that named two block types as examples of
 * what a node's `type` holds. That comment was worth fixing, but it was not a second
 * catalogue, and a gate that cannot tell the difference gets suppressed rather than
 * obeyed. Prose explaining the engine by example is exactly how the engine should be
 * explained; a `case 'action.assignRole':` is not.
 *
 * Comments are matched in the *same pass* as string literals even though the
 * literals are kept, so that a `//` inside a string cannot be mistaken for a comment
 * and swallow the code after it. Stripping comments first fails open — see the same
 * fix, and the reproduction, in `engineVocabulary.test.ts`.
 */
function stripComments(source: string): string {
    return source.replace(
        /(`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
        (match, literal: string | undefined) => literal ?? ' '
    );
}

/**
 * Files permitted to depend on one named block, each with the reason.
 *
 * Two different kinds of thing, deliberately listed together so the count stays
 * visible — this is the exact surface on which "adding a block is one directory"
 * is qualified, and it should be uncomfortable to add to.
 *
 * `templates/` is a *settled* exception: a template is a concrete flow built out of
 * specific blocks, so naming them is its whole job, and the same reasoning already
 * puts it outside the engine's vocabulary gate.
 *
 * The other two are **residual debt, not design.** A gateway dispatcher asks the
 * registry which trigger an event starts — that part is generic — and then reaches
 * into that one block's exported schema to read its config. It works, but it means
 * a new trigger with its own matching rule still needs an edit here. Closing it
 * needs a contract member for trigger matching, which is an M2-shaped change; it is
 * recorded rather than quietly accepted.
 */
const DECLARED_BLOCK_DEPENDENTS: Readonly<Record<string, string>> = {
    'src/features/flows/templates/onboardingFlow.ts':
        'A template is a concrete flow, so it names the blocks it is made of.',
    'src/features/flows/engine/reactionAddDispatch.ts':
        'Residual: reads triggerReactionAdd\'s schema to match an incoming reaction.',
    'src/features/flows/logic/deployFlowButtons.ts':
        'Residual: reads triggerButtonClick\'s schema to render its button.',
};

/**
 * Importing another block's module, which is how a real dependency is written.
 *
 * The literal check below is not enough on its own, and this gate shipped briefly
 * believing it was. `blocks/index.ts` explicitly blesses importing a block's
 * directory for its exported constants, so the idiomatic way to special-case a
 * block — `import { CONDITION_IS_BOOSTER } from '../blocks/conditionIsBooster'`
 * then `case CONDITION_IS_BOOSTER:` — contains no block-type literal anywhere and
 * sailed through. A review caught it by noticing the gate was already green on
 * `templates/onboardingFlow.ts`, which names three block types exactly that way.
 */
const CROSS_BLOCK_IMPORT = /from\s+['"][^'"]*blocks\/([A-Za-z0-9_]+)['"]/g;

/** The contract files, which every block legitimately imports. */
const BLOCK_CONTRACT_MODULES = ['manifest', 'registry', 'types', 'conformance', 'index'];

/**
 * Generous, because this suite reads ~113 files and transpiles 13 block modules
 * inside one assertion. It fits in the 5s default when run alone, and has been seen
 * to exceed it under a full parallel run — where the failure reads as "the
 * one-directory claim broke" rather than "the machine was busy".
 */
const GATE_TIMEOUT_MS = 30_000;

describe('no file outside a block names a block type', () => {
    it('finds every shipped block type written outside its own directory', async () => {
        await ensureBlocksDiscovered();
        const definitions = listBlockDefinitions();
        expect(definitions.length).toBeGreaterThan(0);

        const types = definitions.map((definition) => definition.type);
        const ownedType = declaredTypeByDirectory(types);

        // Every shipped block must be attributed to a directory, or a block whose
        // manifest this gate failed to parse would be silently exempt everywhere.
        expect(
            types.filter((type) => ![...ownedType.values()].includes(type)),
            'These block types were not traced back to a directory, so nothing would ' +
                'be checked against them. Has a manifest stopped declaring `type:` inline?'
        ).toEqual([]);

        // One directory per type, or a directory would inherit a sibling's exemption.
        expect(
            new Set(ownedType.values()).size,
            'Two directories resolved to the same block type, which would let each ' +
                "name the other's."
        ).toBe(ownedType.size);

        const offences: string[] = [];

        for (const tree of SCANNED_TREES) {
            for (const file of collectSourceFiles(tree)) {
                if (isTestFile(file)) continue;
                const owner = owningBlockDirectory(file);
                const relativePath = relative(REPO_ROOT, file).split(sep).join('/');
                const declaredReason = DECLARED_BLOCK_DEPENDENTS[relativePath];
                const text = stripComments(readFileSync(file, 'utf8'));

                for (const type of types) {
                    // A block's directory may name the one type that block declares,
                    // and no other — naming a sibling's type is a cross-block
                    // dependency, which is what the one-directory claim rules out.
                    if (owner !== undefined && ownedType.get(owner) === type) continue;
                    if (declaredReason) continue;

                    // Backticks included: a template literal is a block type just as
                    // much as a quoted one is.
                    if (
                        text.includes(`'${type}'`) ||
                        text.includes(`"${type}"`) ||
                        text.includes(`\`${type}\``)
                    ) {
                        offences.push(`${relativePath} names '${type}'`);
                    }
                }

                for (const match of text.matchAll(CROSS_BLOCK_IMPORT)) {
                    const imported = match[1];
                    if (BLOCK_CONTRACT_MODULES.includes(imported)) continue;
                    if (imported === owner) continue;
                    if (declaredReason) continue;
                    offences.push(`${relativePath} imports blocks/${imported}`);
                }
            }
        }

        expect(
            offences,
            'A block type named — or a block module imported — outside that block is a ' +
                'second copy of the catalogue. Whatever this file needed about the block, ' +
                "read it off the block's manifest (server) or its NodeDescriptor " +
                '(browser). If the dependency is genuinely unavoidable, add the file to ' +
                'DECLARED_BLOCK_DEPENDENTS in this test with the reason, and expect to ' +
                'justify it: that list is the surface on which the one-directory claim ' +
                'is qualified.'
        ).toEqual([]);
    }, GATE_TIMEOUT_MS);

    it('keeps the declared exceptions honest', () => {
        // A stale exception is worse than none: it exempts a file that no longer needs
        // exempting, and the next reader assumes the dependency is still there.
        for (const [path, reason] of Object.entries(DECLARED_BLOCK_DEPENDENTS)) {
            const text = stripComments(readFileSync(join(REPO_ROOT, path), 'utf8'));
            const imports = [...text.matchAll(CROSS_BLOCK_IMPORT)]
                .map((match) => match[1])
                .filter((imported) => !BLOCK_CONTRACT_MODULES.includes(imported));
            expect(
                imports.length,
                `${path} is listed as depending on a block ("${reason}") but no longer ` +
                    'imports one. Remove it from DECLARED_BLOCK_DEPENDENTS.'
            ).toBeGreaterThan(0);
        }
    });
});

/**
 * What `web/src/flows/nodeMeta.ts` is allowed to export.
 *
 * Every name here is generic — it is about *kinds*, *tones*, durations or colours,
 * none of which is per-block. The catalogues this file used to hold were all
 * exported too, so the list is pinned exactly rather than merely checked for
 * known-bad names: an assertion about what is absent can only catch the copies we
 * thought of, and this one catches any.
 *
 * Adding a name here is a deliberate act. If the thing being added is per-block, it
 * belongs on the manifest instead and this list is the wrong fix.
 */
const NODE_META_ALLOWED_EXPORTS = [
    'KindStyle',
    'KIND_STYLES',
    'HANDLE_TONE_COLORS',
    'HANDLE_TONE_HEX',
    'handlesAreLabelled',
    'formatDuration',
    'defaultDataFor',
    'emptyGraph',
    'roleColorHex',
].sort();

describe('nodeMeta.ts exports only generic helpers', () => {
    it('exports exactly the allowed set', () => {
        const file = join(REPO_ROOT, 'web', 'src', 'flows', 'nodeMeta.ts');
        const text = readFileSync(file, 'utf8');

        // Read as text because the root tsconfig excludes `web/`, so this file is not
        // in this program and cannot be imported for its shape.
        const exported = [
            ...text.matchAll(
                /^export\s+(?:declare\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gm
            ),
        ].map((match) => match[1]);

        // Guard the regex itself: a refactor to `export { a, b }` would otherwise
        // empty this list and the assertion would pass by finding nothing.
        expect(exported.length, 'Found no exports at all — has the export style changed?').toBeGreaterThan(
            0
        );

        // Every export form this gate cannot read, rejected by name rather than
        // ignored. `export * from './blockCatalogue'` is the one that matters: it
        // would restore the whole catalogue while leaving the list below untouched.
        expect(
            text,
            'This gate only understands inline `export const/function/type/...` ' +
                'declarations. Another form here would be invisible to it.'
        ).not.toMatch(/^export\s*(?:\{|\*|default\b|async\b|type\s*\{)/m);

        expect(
            [...new Set(exported)].sort(),
            'nodeMeta.ts is the file the browser\'s block catalogue used to live in. ' +
                'A new export here is either generic — add it to NODE_META_ALLOWED_EXPORTS ' +
                'in this test — or it is per-block, in which case it belongs on the ' +
                'block manifest in src/features/flows/blocks/<block>/.'
        ).toEqual(NODE_META_ALLOWED_EXPORTS);
    });
});
