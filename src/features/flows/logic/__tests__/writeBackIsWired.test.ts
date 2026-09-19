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

    it('is run by the apply handler after an install', () => {
        const source = read('provisioning', 'commands', 'applyJourneyButton.ts');

        expect(source).toMatch(/runResourceWriteBack\(/);
    });

    it('runs after the install, not before it', () => {
        // Writing ids back before the guild is mutated would write the ids that
        // existed *last* time, which is worse than writing none.
        const source = read('provisioning', 'commands', 'applyJourneyButton.ts');
        const installIndex = source.indexOf('await installJourney(');
        const writeBackIndex = source.indexOf('runResourceWriteBack(');

        expect(installIndex).toBeGreaterThan(-1);
        expect(writeBackIndex).toBeGreaterThan(installIndex);
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
