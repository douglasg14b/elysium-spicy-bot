import { describe, expect, it } from 'vitest';
import { getBlockDefinition, listBlockDefinitions } from '../blocks/registry';

/**
 * Its own file on purpose: this is the only place that must observe the registry
 * *before* anything has awaited discovery, and vitest gives each test file its
 * own module registry.
 *
 * The failure this rules out is the expensive one. A lazily-populated map would
 * answer "no such block" while the scan was still running, so a graph save would
 * validate because nothing was discovered and the builder would show an empty
 * palette — with nothing anywhere saying why.
 */
describe('reading the registry before discovery finishes', () => {
    it('raises, naming what has to be awaited', () => {
        expect(() => getBlockDefinition('action.sendDM')).toThrow(/ensureBlocksDiscovered/);
    });

    it('raises for the listing too, rather than reporting an empty catalogue', () => {
        expect(() => listBlockDefinitions()).toThrow(/before discovery finished/);
    });
});
