import { beforeAll, describe, expect, it } from 'vitest';
import type { BlockManifest } from '../../../features/flows/blocks/manifest';
import { ensureBlocksDiscovered, listBlockDefinitions } from '../../../features/flows/blocks/registry';
import { NON_WIRE_MEMBERS, type NodeDescriptor, nodeRoutes, toDescriptor } from '../nodeRoutes';

/**
 * The palette contract. The builder draws a node purely from what this route
 * serves, so these tests are the guard on both halves of that: everything the
 * manifest declares for presentation arrives, and the two members that must stay
 * server-side never do.
 *
 * `nodeRoutes()` is a bare Hono app — auth is applied where it is mounted in
 * `api/index.ts` — so it can be exercised directly without a session.
 */

/** Two handles and a suspending action: the richest descriptor in the registry. */
const WAIT_FOR_EVENT = 'action.waitForEvent';
/** Two handles and a role picker: the branching case. */
const HAS_ROLE = 'condition.hasRole';

async function fetchNodes(): Promise<readonly NodeDescriptor[]> {
    const response = await nodeRoutes().request('/');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { nodes: readonly NodeDescriptor[] };
    return body.nodes;
}

function manifestFor(type: string): BlockManifest {
    const manifest = listBlockDefinitions().find((definition) => definition.type === type);
    if (!manifest) {
        throw new Error(`Test fixture expects a registered block "${type}".`);
    }
    return manifest;
}

function descriptorFor(nodes: readonly NodeDescriptor[], type: string): NodeDescriptor {
    const descriptor = nodes.find((node) => node.type === type);
    if (!descriptor) {
        throw new Error(`GET /api/nodes did not serve "${type}".`);
    }
    return descriptor;
}

describe('GET /api/nodes', () => {
    let nodes: readonly NodeDescriptor[];

    beforeAll(async () => {
        // The registry is an async filesystem scan; reading it first raises.
        await ensureBlocksDiscovered();
        nodes = await fetchNodes();
    });

    it('serves every registered block', () => {
        const served = nodes.map((node) => node.type).sort();
        const registered = listBlockDefinitions()
            .map((definition) => definition.type)
            .sort();

        expect(served).toEqual(registered);
        expect(served.length).toBeGreaterThan(0);
    });

    it('carries the whole presentation descriptor for a suspending, multi-handle action', () => {
        const descriptor = descriptorFor(nodes, WAIT_FOR_EVENT);
        const manifest = manifestFor(WAIT_FOR_EVENT);

        expect(descriptor.kind).toBe('action');
        expect(descriptor.label).toBe(manifest.label);
        expect(descriptor.description).toBe(manifest.description);
        expect(descriptor.group).toBe(manifest.group);
        expect(descriptor.icon).toBe(manifest.icon);
        expect(descriptor.canSuspend).toBe(true);

        // The inspector form: both fields, in manifest order, with their options.
        expect(descriptor.configFields).toEqual(manifest.configFields);
        expect(descriptor.configFields.map((field) => field.key)).toEqual(['eventKind', 'timeoutMs']);

        // Both exits, including the named timeout handle the builder must draw.
        expect(descriptor.handles).toEqual(manifest.handles);
        expect(descriptor.handles).toHaveLength(2);
        expect(descriptor.handles.map((handle) => handle.id)).toEqual([undefined, 'timeout']);

        expect(descriptor.outputs).toEqual(manifest.outputs);
        expect(descriptor.requires).toEqual(manifest.requires);
        expect(descriptor.capabilities).toEqual(manifest.capabilities);
    });

    it('carries both branches and the role picker of a condition', () => {
        const descriptor = descriptorFor(nodes, HAS_ROLE);
        const manifest = manifestFor(HAS_ROLE);

        expect(descriptor.kind).toBe('condition');
        expect(descriptor.group).toBe('conditions');
        expect(descriptor.icon).toBe(manifest.icon);
        expect(descriptor.description).toBe(manifest.description);
        expect(descriptor.configFields).toEqual(manifest.configFields);
        expect(descriptor.configFields[0]?.control).toBe('rolePicker');
        expect(descriptor.handles.map((handle) => handle.id)).toEqual(['true', 'false']);
        expect(descriptor.requires).toEqual(['member']);
        expect(descriptor.canSuspend).toBe(false);
    });

    it('serves startedBy for triggers and omits it everywhere else', () => {
        for (const descriptor of nodes) {
            const manifest = manifestFor(descriptor.type);
            if (manifest.startedBy === undefined) {
                // The serialized shape, which is the contract with the browser:
                // JSON drops the key even though the spread retains it undefined.
                expect(descriptor).not.toHaveProperty('startedBy');
            } else {
                expect(descriptor.startedBy).toBe(manifest.startedBy);
            }
        }

        // At least one trigger exists, or the branch above proves nothing.
        expect(nodes.some((node) => node.startedBy !== undefined)).toBe(true);
    });

    it('never serializes the config schema or the run function, for any block', () => {
        for (const descriptor of nodes) {
            for (const member of NON_WIRE_MEMBERS) {
                expect(descriptor).not.toHaveProperty(member);
            }
        }
    });

    it('strips the non-wire members before serialization, not by accident of JSON', () => {
        // The test above is strong for `configSchema` — a Zod schema does serialize,
        // so leaking it would show up on the wire. It is blind to `run`, because
        // JSON.stringify drops functions whatever the route does. Asserting on the
        // pre-serialization object is what actually holds the route to stripping it.
        for (const definition of listBlockDefinitions()) {
            const descriptor: object = toDescriptor(definition);
            for (const member of NON_WIRE_MEMBERS) {
                expect(Object.hasOwn(descriptor, member)).toBe(false);
            }
            // The manifest it came from really did carry them, or the above is moot.
            // Driven off the same list so a third name added there is load-bearing
            // here too, rather than only at build time.
            for (const member of NON_WIRE_MEMBERS) {
                expect(Object.hasOwn(definition, member)).toBe(true);
            }
        }
    });

    it('serves exactly the manifest keys minus the non-wire members', () => {
        // The drift guard. Because the route subtracts rather than constructs, a
        // manifest field added tomorrow appears on the wire on its own — and if
        // someone rewrites the route as a hand-built object, this fails.
        for (const descriptor of nodes) {
            const manifest = manifestFor(descriptor.type);
            // Undefined-valued keys are filtered out because `descriptor` has been
            // through JSON, which drops them: a manifest writing `startedBy:
            // undefined` explicitly would otherwise fail this and accuse the route.
            const expected = Object.entries(manifest)
                .filter(([key, value]) => value !== undefined && !NON_WIRE_MEMBERS.some((member) => member === key))
                .map(([key]) => key)
                .sort();

            expect(Object.keys(descriptor).sort()).toEqual(expected);
        }
    });
});
