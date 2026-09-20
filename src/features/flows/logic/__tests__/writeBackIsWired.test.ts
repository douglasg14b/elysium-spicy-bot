import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * That write-back actually runs after an install.
 *
 * `bindResourcesToGraph` and `resolveJourneyResources` were both written, exported,
 * typechecked and tested while having **no caller at all** — the second was missed by
 * a first audit and found only when the operator asked what else was unwired. They
 * join `incrementTicketNumber`, `ticketChannelValidation`, `ticketCommands.ts` and
 * `BLOCK_CAPABILITIES` as the fifth and sixth cases in this repo.
 *
 * The chain here is deliberately indirect — provisioning must not import flows, so
 * flows registers a callback — and an indirection is exactly what a typechecker
 * cannot prove is connected. Both ends are asserted as source text: the registration
 * on the flows side, and the call on the provisioning side.
 */

const FEATURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function read(...segments: string[]): string {
    return readFileSync(join(FEATURES, ...segments), 'utf8');
}

describe('resource write-back is reachable', () => {
    it('is registered when flows initialise', () => {
        const source = read('flows', 'initFlows.ts');

        expect(source).toMatch(/registerResourceWriteBack\(\s*applyResourcesToFlows\s*\)/);
    });

    /*
     * Asserted against `runInstall.ts` rather than the button handler it was
     * extracted from. That is where the call now lives, and it is the shared sequence
     * *every* surface installs through — the `/install-journey` Apply button and the
     * dashboard's `POST /install` route both call it. Checking the button handler
     * would now pass or fail on one caller's rendering rather than on whether an
     * install writes its ids back at all.
     */
    it('is run after an install', () => {
        const source = read('provisioning', 'logic', 'runInstall.ts');

        expect(source).toMatch(/runResourceWriteBack\(/);
    });

    it('runs after the install, not before it', () => {
        // Writing ids back before the guild is mutated would write the ids that
        // existed *last* time, which is worse than writing none.
        const source = read('provisioning', 'logic', 'runInstall.ts');
        const installIndex = source.indexOf('await installJourney(');
        const writeBackIndex = source.indexOf('runResourceWriteBack(');

        expect(installIndex).toBeGreaterThan(-1);
        expect(writeBackIndex).toBeGreaterThan(installIndex);
    });

    /*
     * Both install surfaces go through that one sequence.
     *
     * The reason the assertion above could move safely: if a surface stopped calling
     * `runInstall` and inlined its own preview-and-apply, it would silently skip the
     * write-back and every test above would still pass. This is what makes the single
     * path a fact rather than a convention.
     */
    it('is reached by every surface that installs', () => {
        expect(read('provisioning', 'commands', 'applyJourneyButton.ts')).toMatch(
            /runInstall\(/
        );
        expect(
            readFileSync(join(FEATURES, '..', 'web', 'api', 'flowRoutes.ts'), 'utf8')
        ).toMatch(/runInstall\(/);
    });
});

describe('the dependency direction holds', () => {
    it('provisioning does not import flows', () => {
        // Provisioning is a base capability. The import would work today and invert
        // the dependency permanently, which is why the write-back is a callback the
        // consumer registers rather than a direct call.
        const files = [
            read('provisioning', 'index.ts'),
            read('provisioning', 'initProvisioning.ts'),
            read('provisioning', 'provisioningService.ts'),
            read('provisioning', 'resourceWriteBack.ts'),
            read('provisioning', 'logic', 'runInstall.ts'),
            read('provisioning', 'commands', 'applyJourneyButton.ts'),
            read('provisioning', 'commands', 'installJourneyCommand.ts'),
        ];

        for (const source of files) {
            // Strip comments: the barrel *describes* this rule in prose, and the
            // check is about imports, not about whether the rule is mentioned.
            const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
            expect(code).not.toMatch(/from\s+'[^']*features\/flows/);
            expect(code).not.toMatch(/from\s+'\.\.\/\.\.\/flows/);
            expect(code).not.toMatch(/from\s+'\.\.\/flows/);
        }
    });
});
