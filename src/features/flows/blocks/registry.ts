import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BlockManifest, BlockTriggerSource } from './manifest';

/**
 * The block registry, populated by scanning this directory.
 *
 * A block ships as one directory here whose entry module exports `block`. There
 * is no array to append to and no barrel line to add, which is the whole point:
 * the only file a block author writes is inside their own directory.
 *
 * Discovery is asynchronous, so it is awaited **once** during feature init,
 * before anything that could run a flow is wired up. The lookups below stay
 * synchronous and raise if they are somehow reached first — a registry that
 * quietly answered "no such block" while the scan was still running would turn
 * a startup ordering bug into an empty palette and a graph that validates
 * because nothing was discovered.
 */

/** Where the product's blocks live: this file's own directory. */
const BLOCKS_ROOT = path.dirname(fileURLToPath(import.meta.url));

/** The export a block directory's entry module must provide. */
export const BLOCK_MODULE_EXPORT = 'block';

/**
 * Entry module inside a block directory.
 *
 * Deliberately the TypeScript source: the environments that actually run this
 * are vitest and tsx (locally and in the container, which runs the bot from
 * source). The compiled output in `dist/` is not executed by anything.
 */
const BLOCK_ENTRY_MODULE = 'index.ts';

/**
 * A directory whose name starts with either of these is not a block — `_` for
 * scratch or fixture trees, `.` for tool directories.
 */
const NON_BLOCK_PREFIXES = ['_', '.'] as const;

/** The least a discovered module must be for the registry to key it. */
export interface DiscoverableBlock {
    readonly type: string;
}

/**
 * Scan `root` for block directories and import each one's `block` export.
 *
 * Every directory must contain {@link BLOCK_ENTRY_MODULE} exporting
 * {@link BLOCK_MODULE_EXPORT} with a non-empty `type`, and no two may claim the
 * same `type`. Each of those is a named error rather than a skipped directory,
 * because a block silently missing from the registry looks exactly like a block
 * that was never written.
 *
 * `TBlock` is asserted by the caller: discovery checks that a block is an object
 * carrying a usable `type` and stops there. Whether it satisfies the full
 * manifest contract is the conformance suite's question, and answering it in two
 * places would let the two answers disagree.
 */
export async function discoverBlocks<TBlock extends DiscoverableBlock>(
    root: string = BLOCKS_ROOT
): Promise<ReadonlyMap<string, TBlock>> {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const blockDirectories = entries
        .filter((entry) => entry.isDirectory() && !NON_BLOCK_PREFIXES.some((prefix) => entry.name.startsWith(prefix)))
        // Sorted so the palette and every log line have a stable order whatever
        // the filesystem returns.
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));

    // Imported concurrently, then folded in sorted order: the modules are
    // independent, so awaiting them one at a time only adds their latencies
    // together on the boot path.
    //
    // `allSettled` rather than `all` so the *reported* failure is the first in
    // directory order rather than whichever import happened to reject first.
    // Two broken blocks otherwise name a different directory on each run, purely
    // because disk latency reordered them.
    const imported = await Promise.allSettled(
        blockDirectories.map(async (directory) => importBlock(root, directory))
    );

    const discovered = new Map<string, TBlock>();
    const directoryByType = new Map<string, string>();

    for (const [index, directory] of blockDirectories.entries()) {
        const result = imported[index];
        if (result.status === 'rejected') {
            // Thrown as-is: importBlock already says which directory failed and
            // whether the module was missing or threw, and those have different fixes.
            throw result.reason;
        }

        const block = result.value;
        const claimedBy = directoryByType.get(block.type);
        if (claimedBy) {
            throw new Error(
                `Two blocks claim the type "${block.type}": blocks/${claimedBy} and blocks/${directory}. ` +
                    'A block type is the key every saved graph references, so it must be unique.'
            );
        }

        directoryByType.set(block.type, directory);
        // The caller's assertion, documented above.
        discovered.set(block.type, block as TBlock);
    }

    return discovered;
}

/** Import one block directory's entry module and return its `block` export. */
async function importBlock(root: string, directory: string): Promise<DiscoverableBlock> {
    const modulePath = path.join(root, directory, BLOCK_ENTRY_MODULE);
    // Always a file URL: Windows cannot `import()` a bare absolute path.
    const moduleUrl = pathToFileURL(modulePath).href;

    let module: Record<string, unknown>;
    try {
        module = (await import(moduleUrl)) as Record<string, unknown>;
    } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown import error';
        // "You forgot index.ts" and "your block threw while loading" are
        // different problems with different fixes, so they get different
        // sentences rather than one that could mean either.
        throw new Error(
            isModuleNotFound(error)
                ? `Block directory blocks/${directory} has no loadable ${BLOCK_ENTRY_MODULE}: ${reason}`
                : `Block blocks/${directory} threw while loading its ${BLOCK_ENTRY_MODULE}: ${reason}`
        );
    }

    const block = module[BLOCK_MODULE_EXPORT];
    if (!block || typeof block !== 'object') {
        throw new Error(
            `Block directory blocks/${directory} must export \`${BLOCK_MODULE_EXPORT}\` from its ` +
                `${BLOCK_ENTRY_MODULE}. Found: ${Object.keys(module).join(', ') || 'no exports'}.`
        );
    }

    const { type } = block as { type?: unknown };
    if (typeof type !== 'string' || !type) {
        throw new Error(
            `Block blocks/${directory} must declare a non-empty string \`type\`; found ${JSON.stringify(type)}.`
        );
    }

    return block as DiscoverableBlock;
}

/**
 * Whether an import failed because the module is absent rather than because it
 * ran and threw. Node reports the first as `ERR_MODULE_NOT_FOUND`; the bundlers
 * this repo runs under (vite-node, tsx) both surface a "cannot find" message.
 */
function isModuleNotFound(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }
    if ((error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND') {
        return true;
    }
    const message = error.message.toLowerCase();
    return message.includes('cannot find') || message.includes('failed to load url');
}

let registry: ReadonlyMap<string, BlockManifest> | undefined;
let discovery: Promise<ReadonlyMap<string, BlockManifest>> | undefined;

/**
 * Populate the registry, once per process.
 *
 * Awaited by `initFlows` before it registers any interaction handler, gateway
 * listener, or scheduler, and the in-process web server starts after that — so
 * no route, save, or trigger can observe a half-populated registry. A failed
 * scan is not retried: the memoized rejection keeps failing loudly rather than
 * letting a second caller run with fewer blocks than the first.
 */
export async function ensureBlocksDiscovered(): Promise<void> {
    discovery ??= discoverBlocks<BlockManifest>();
    registry = await discovery;
}

function requireRegistry(): ReadonlyMap<string, BlockManifest> {
    if (!registry) {
        throw new Error(
            'The block registry was read before discovery finished. Await ensureBlocksDiscovered() ' +
                'during initialization (initFlows does this) before running or validating a flow.'
        );
    }
    return registry;
}

/** Look up a block by the `type` a saved graph references. */
export function getBlockDefinition(type: string): BlockManifest | undefined {
    return requireRegistry().get(type);
}

/** Every registered block, in directory-name order. */
export function listBlockDefinitions(): readonly BlockManifest[] {
    return [...requireRegistry().values()];
}

/**
 * Whether a node's block is a trigger started by `source`.
 *
 * What the gateway dispatchers ask instead of comparing against an imported type
 * constant. A dispatcher written this way keeps working when a second trigger
 * declares the same source, and an unknown type is simply not a match — the
 * loud version of that is save-time validation's job, not a listener's.
 */
export function isTriggerStartedBy(type: string, source: BlockTriggerSource): boolean {
    const block = requireRegistry().get(type);
    return block?.kind === 'trigger' && block.startedBy === source;
}
