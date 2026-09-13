import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BlockManifest } from '../blocks/manifest';
import {
    discoverBlocks,
    ensureBlocksDiscovered,
    getBlockDefinition,
    listBlockDefinitions,
} from '../blocks/registry';

const FIXTURE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'blocks');

const fixtureRoot = (name: string): string => path.join(FIXTURE_ROOT, name);

/**
 * The thirteen blocks that ship today, in the order a directory scan yields them.
 *
 * Pinned rather than counted: the palette shows them in this order, and the
 * point of discovery is that this list is derived from the tree instead of
 * hand-maintained. If a block is added or renamed, this is the one place that
 * says so — which is the opposite of the registry array it replaced.
 *
 * So this list is an **inventory**, not a catalogue, and the difference is the
 * whole of M1: nothing here decides how a block looks, validates or runs. Adding
 * `condition.isBooster` — the block that proved the one-directory claim — needed
 * one directory and this one line, and no edit anywhere in the browser.
 */
const SHIPPED_BLOCK_TYPES = [
    'action.assignRole',
    'action.delay',
    'action.postEmbed',
    'action.removeRole',
    'action.sendDM',
    'action.sendMessage',
    'action.waitForEvent',
    'condition.hasRole',
    'condition.inChannel',
    'condition.isBooster',
    'trigger.buttonClick',
    'trigger.memberJoin',
    'trigger.reactionAdd',
] as const;

describe('scanning the blocks tree', () => {
    it('finds every shipped block, in a stable order', async () => {
        const discovered = await discoverBlocks<BlockManifest>();

        expect([...discovered.keys()]).toEqual([...SHIPPED_BLOCK_TYPES]);
    });

    it('registers a block because its directory exists, with nothing else edited', async () => {
        const discovered = await discoverBlocks<BlockManifest>(fixtureRoot('conforming'));

        // One directory in, one block out — and an underscore-prefixed sibling
        // ignored rather than treated as a malformed block.
        expect([...discovered.keys()]).toEqual(['fixture.conforming']);
        expect(discovered.get('fixture.conforming')?.label).toBe('Fixture Block');
    });

    it('refuses two blocks claiming one type, naming both directories', async () => {
        await expect(discoverBlocks(fixtureRoot('duplicateType'))).rejects.toThrow(
            /fixture\.duplicate.*firstClaimant.*secondClaimant/s
        );
    });

    it('refuses a directory whose entry module does not export `block`', async () => {
        // The quiet version of this failure is a block missing from the palette
        // with no explanation, so the directory has to be named.
        await expect(discoverBlocks(fixtureRoot('missingExport'))).rejects.toThrow(
            /mysteryBlock.*export `block`/s
        );
    });

    it('refuses a directory with no entry module', async () => {
        await expect(discoverBlocks(fixtureRoot('noEntryModule'))).rejects.toThrow(
            /lostBlock.*no loadable index\.ts/s
        );
    });

    it('blames the same block every run when two are broken at once', async () => {
        // Imports run concurrently, so the first *rejection* is whichever lost the
        // race — here the one that sorts last. An author chasing an intermittent
        // error message is being sent to a different file on each run, so the
        // reported failure follows directory order instead.
        await expect(discoverBlocks(fixtureRoot('twoBroken'))).rejects.toThrow(
            /alphaBlock threw while loading.*failed slowly/s
        );
    });

    it('says when a block threw while loading, rather than blaming a missing file', async () => {
        // Same symptom, opposite fix: one directory needs a file written, the
        // other needs a bug fixed. One message for both would send an author
        // looking for the wrong thing.
        await expect(discoverBlocks(fixtureRoot('throwingModule'))).rejects.toThrow(
            /explodingBlock threw while loading.*exploded on import/s
        );
    });
});

describe('the process-wide registry', () => {
    it('serves synchronous lookups once discovery has been awaited', async () => {
        await ensureBlocksDiscovered();

        expect(getBlockDefinition('action.sendDM')?.label).toBe('Send DM');
        expect(listBlockDefinitions().map((definition) => definition.type)).toEqual([
            ...SHIPPED_BLOCK_TYPES,
        ]);
    });

    it('scans once however many times it is awaited', async () => {
        await ensureBlocksDiscovered();
        const first = getBlockDefinition('action.delay');
        await ensureBlocksDiscovered();

        // Same object, not a re-imported copy: a second scan would give every
        // block a second identity and quietly double the schemas in memory.
        expect(getBlockDefinition('action.delay')).toBe(first);
    });

    it('has no entry for a type nothing declares', async () => {
        await ensureBlocksDiscovered();

        expect(getBlockDefinition('action.doesNotExist')).toBeUndefined();
    });
});
