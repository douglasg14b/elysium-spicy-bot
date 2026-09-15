/**
 * AC1, kept honest: adding a block is one directory.
 *
 * The claim M1 exists to make is that a new block needs no edit outside its own
 * directory — not to the executor, not to the route, and above all not to the
 * browser, which before M1 held three separate per-block catalogues that had to be
 * updated in lockstep and silently were not.
 *
 * Asserting that from inspection proves nothing, and proving it once by adding a
 * block proves it only for the day it was added. So this test takes the block that
 * was added to demonstrate it — `condition.isBooster`, the last block written under
 * M1 and the first written *against* the finished contract — and drives it all the
 * way from the real registry, through the real HTTP route, into the browser's real
 * rendering functions. Nothing here is a fixture or a stand-in.
 *
 * If a future change reintroduces a place that has to learn about each block, this
 * fails, because the block it renders was never taught to that place.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { ensureBlocksDiscovered } from '../../../features/flows/blocks/registry';
import { type NodeDescriptor, nodeRoutes } from '../nodeRoutes';
import { summarizeFromDescriptor } from '../../../../web/src/flows/cardSummary';
import { defaultDataFor } from '../../../../web/src/flows/nodeMeta';
import { KIND_STYLES, handlesAreLabelled } from '../../../../web/src/flows/nodeMeta';
import type { NodeDescriptor as BrowserNodeDescriptor } from '../../../../web/src/api/types';

/**
 * The block added to prove the claim.
 *
 * Chosen for what it exercises rather than for being easy: it is a *condition*, so
 * it has two labelled handles and branches; it declares an optional `note`; it has
 * no config fields at all, which is the case a naive renderer built around a config
 * form gets wrong; and its card summary is a pure literal, the arm of the summary
 * interpreter that no other shipped block uses.
 */
const PROOF_BLOCK = 'condition.isBooster';

describe('a block added as one directory renders end to end', () => {
    let descriptor: NodeDescriptor;

    beforeAll(async () => {
        await ensureBlocksDiscovered();
        const response = await nodeRoutes().request('/');
        expect(response.status).toBe(200);
        const body = (await response.json()) as { nodes: readonly NodeDescriptor[] };
        const served = body.nodes.find((node) => node.type === PROOF_BLOCK);
        if (!served) {
            throw new Error(
                `GET /api/nodes did not serve "${PROOF_BLOCK}". The block is discovered from its ` +
                    'directory alone, so this means discovery or the route stopped being generic.'
            );
        }
        descriptor = served;
    });

    it('arrives over the wire with everything the palette draws from', () => {
        // The palette needs a glyph, a label, a blurb and a group. None of these is
        // held anywhere in the browser any more.
        expect(descriptor.icon).toBe('💎');
        expect(descriptor.label).toBe('Is Booster?');
        expect(descriptor.group).toBe('conditions');
        expect(descriptor.description).toContain('boosting');
        expect(descriptor.note).toBeTruthy();

        // And the kind must be one the browser's own style table already covers,
        // without that table having been touched.
        expect(Object.keys(KIND_STYLES)).toContain(descriptor.kind);
    });

    it('draws its card from the descriptor alone', () => {
        // A single assertion, not `as unknown as`: the only thing the two types
        // disagree about is variance — the server's arrays are `readonly`, the
        // browser's are mutable so React state can hold them. A double hop would
        // also swallow genuine field-level drift, which is what
        // `nodeDescriptorDrift.test.ts` exists to catch and this must not hide.
        const browserDescriptor = descriptor as BrowserNodeDescriptor;

        // A block with no config fields still seeds cleanly — no keys, not a crash.
        expect(defaultDataFor(browserDescriptor)).toEqual({});

        // The literal arm of the summary interpreter, which is what this block uses.
        expect(summarizeFromDescriptor(browserDescriptor, {}, [], [])).toBe('Currently boosting?');
    });

    it('branches with labelled exits, on the shared rule', () => {
        expect(descriptor.handles.map((handle) => handle.id)).toEqual(['true', 'false']);

        // Two handles, so the card and the edges both label them — decided by the
        // same helper the renderer uses, not restated here.
        expect(handlesAreLabelled(descriptor.handles)).toBe(true);
        expect(descriptor.handles.map((handle) => handle.label)).toEqual(['Yes', 'No']);
        expect(descriptor.handles.map((handle) => handle.tone)).toEqual(['positive', 'negative']);
    });
});

/**
 * The claim re-proved by the next block written, rather than only by the one
 * written to prove it.
 *
 * `condition.isBooster` above was written the day the contract was finished, so
 * it says the claim held once. `action.pickRandom` is the first block added after
 * two further steps of engine work, and it is the harder case in two ways the
 * first never touched: it carries a `textList` field, whose value is a list rather
 * than a scalar, and it *declares an output* — the first shipped block to do so.
 *
 * It reaches the browser here without one line changing in `web/src`.
 */
const LATER_BLOCK = 'action.pickRandom';

describe('a block added after the contract settled still needs only its directory', () => {
    let descriptor: NodeDescriptor;

    beforeAll(async () => {
        await ensureBlocksDiscovered();
        const response = await nodeRoutes().request('/');
        expect(response.status).toBe(200);
        const body = (await response.json()) as { nodes: readonly NodeDescriptor[] };
        const served = body.nodes.find((node) => node.type === LATER_BLOCK);
        if (!served) {
            throw new Error(
                `GET /api/nodes did not serve "${LATER_BLOCK}". The block is discovered from its ` +
                    'directory alone, so this means discovery or the route stopped being generic.'
            );
        }
        descriptor = served;
    });

    it('reaches the palette with its glyph, blurb and group intact', () => {
        expect(descriptor.icon).toBe('🎲');
        expect(descriptor.label).toBe('Pick at Random');
        expect(descriptor.group).toBe('actions');
        expect(Object.keys(KIND_STYLES)).toContain(descriptor.kind);
    });

    it('seeds a dropped node from the defaults it declares, list and all', () => {
        const browserDescriptor = descriptor as BrowserNodeDescriptor;

        // `defaultDataFor` knows no block type; it reads `defaultValue` off each
        // declared field. A list-valued default is the case a scalar-shaped seeder
        // would quietly drop.
        expect(defaultDataFor(browserDescriptor)).toEqual({
            options: ['Heads', 'Tails'],
            outputKey: 'pick',
        });
    });

    it('summarises its list on the card without the browser learning what the field means', () => {
        const browserDescriptor = descriptor as BrowserNodeDescriptor;

        const summary = summarizeFromDescriptor(
            browserDescriptor,
            { options: ['truth', 'dare'], outputKey: 'pick' },
            [],
            []
        );

        expect(summary).toContain('truth');
        expect(summary).toContain('{{var.pick}}');
    });

    it('declares the value it produces, so the wire carries an output at last', () => {
        // Every other shipped block declares `outputs: []`, which means the drift
        // gate has never seen a populated one cross the wire. This is that case.
        expect(descriptor.outputs).toEqual([
            {
                key: 'outputKey',
                label: 'The picked option',
                description: 'Whichever entry came up, under the name this block was given.',
            },
        ]);
    });
});
