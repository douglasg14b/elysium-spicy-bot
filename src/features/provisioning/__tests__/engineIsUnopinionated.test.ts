import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { buildInstallPlan } from '../logic/installPlan';
import type { JourneyDeclaration } from '../logic/resourceDeclaration';
import { validateJourneyDeclaration } from '../logic/resourceDeclaration';

/**
 * That the provisioning engine has no opinion about what a journey contains.
 *
 * The product is a system an operator uses to build *their* structure. Onboarding is
 * an example that proved the engine can express something — it is not a concept the
 * engine knows, and a journey unlike it must work exactly as well.
 *
 * This is a gate rather than a comment because the failure is quiet: a helper written
 * against the one example in the repo keeps passing every other test while refusing
 * every journey nobody wrote yet. One such assumption already shipped and was caught
 * by review, not by a test — `staffRoleIds: []` hardcoded in the install command
 * because the example needed no staff roles.
 */

const PROVISIONING_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Vocabulary from the example that must not appear in engine code.
 *
 * Word-boundary matched, so `verified` does not fire on "cannot be verified" — a
 * gate with false positives gets weakened or deleted, which is worse than no gate.
 */
const EXAMPLE_VOCABULARY = [/\bonboarding\b/i, /\barrivals?\b/i, /\bwelcome\b/i, /\bagree\b/i];

/** Directories holding examples and their tests, which may name example things. */
const EXEMPT_SEGMENTS = ['journeys', '__tests__'];

/**
 * Files allowed to name a bundled example.
 *
 * The composition root chooses *which* journeys ship; that is its job and the reason
 * the engine does not have to know. Everything else must be example-blind.
 *
 * `initProvisioning.ts` was the second entry until the Discord surface was retired;
 * the barrel is all that is left of the root.
 */
const COMPOSITION_ROOT = ['index.ts'];

function sourceFilesUnder(directory: string): string[] {
    const found: string[] = [];

    for (const entry of readdirSync(directory)) {
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) {
            if (EXEMPT_SEGMENTS.includes(entry)) continue;
            found.push(...sourceFilesUnder(full));
            continue;
        }
        if (entry.endsWith('.ts')) found.push(full);
    }

    return found;
}

/** Strip comments — illustrative prose is fine; code that branches on it is not. */
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('the engine holds no example vocabulary', () => {
    it('never names an onboarding concept in executable code', () => {
        const offenders: string[] = [];

        for (const file of sourceFilesUnder(PROVISIONING_ROOT)) {
            const name = relative(PROVISIONING_ROOT, file);
            if (COMPOSITION_ROOT.includes(name)) continue;

            const code = stripComments(readFileSync(file, 'utf8'));
            for (const term of EXAMPLE_VOCABULARY) {
                if (term.test(code)) {
                    offenders.push(`${name} mentions ${term}`);
                }
            }
        }

        expect(offenders).toEqual([]);
    });
});

describe('a journey unlike the example works identically', () => {
    /**
     * Nothing like onboarding: a single flat channel, no category, no role, a
     * permission model naming explicit roles, and keys that share no vocabulary with
     * the bundled example.
     */
    const UNLIKE: JourneyDeclaration = {
        journeyKey: 'archive-vault',
        name: 'Archive Vault',
        resources: [
            {
                key: 'vault',
                kind: 'textChannel',
                defaultName: 'vault',
                permissions: [
                    { audience: 'everyone', access: 'hidden' },
                    { audience: 'roles', roleIds: ['role-keeper'], access: 'readOnly' },
                ],
            },
        ],
    };

    /** A shape the example never exercises: a role with no channels at all. */
    const ROLE_ONLY: JourneyDeclaration = {
        journeyKey: 'badge-only',
        name: 'Badge Only',
        resources: [{ key: 'badge', kind: 'role', defaultName: 'Badge' }],
    };

    function makeGuild() {
        const roles = new Map([
            ['everyone-role', { id: 'everyone-role', name: '@everyone' }],
            ['role-keeper', { id: 'role-keeper', name: 'Keeper' }],
        ]);

        return {
            id: 'guild-1',
            name: 'Test Guild',
            channels: {
                cache: {
                    has: () => false,
                    get: () => undefined,
                    filter: () => ({ map: () => [] }),
                },
            },
            roles: {
                everyone: { id: 'everyone-role' },
                cache: {
                    has: (id: string) => roles.has(id),
                    filter: () => ({ map: () => [] }),
                },
            },
            members: {
                me: {
                    id: 'bot-member',
                    permissions: { has: () => true },
                    roles: { highest: { position: 5 } },
                },
            },
        } as never;
    }

    it('validates a journey with no category and no role', () => {
        expect(() => validateJourneyDeclaration(UNLIKE)).not.toThrow();
    });

    it('plans a channel with an explicit-roles permission model', () => {
        const plan = buildInstallPlan({
            guild: makeGuild(),
            journey: UNLIKE,
            existingBindings: [],
            permissionContext: { staffRoleIds: [] },
        });

        expect(plan.items).toHaveLength(1);
        expect(plan.items[0].action).toBe('create');
        expect(plan.blockers).toEqual([]);
    });

    it('does not require staff roles from a journey that names none', () => {
        // The defect this guards: a caller assuming every journey resolves like the
        // example, so one that does not gets refused or silently mis-permissioned.
        const plan = buildInstallPlan({
            guild: makeGuild(),
            journey: UNLIKE,
            existingBindings: [],
            permissionContext: { staffRoleIds: [] },
        });

        expect(plan.items[0].action).not.toBe('blocked');
    });

    it('plans a journey consisting only of a role', () => {
        const plan = buildInstallPlan({
            guild: makeGuild(),
            journey: ROLE_ONLY,
            existingBindings: [],
            permissionContext: { staffRoleIds: [] },
        });

        expect(plan.items).toHaveLength(1);
        expect(plan.items[0].kind).toBe('role');
        expect(plan.blockers).toEqual([]);
    });
});
