import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * That every boot root registers the ticket type provider, and that provisioning asks it.
 *
 * The hook is deliberately indirect — provisioning must not import tickets, so tickets
 * register an implementation — and an indirection is what a typechecker cannot prove is
 * connected. A boot root that forgot the call would typecheck, pass every unit test that
 * registers a fake, and throw only when an operator installed a journey declaring a ticket
 * type. Asserted as source text, the way `writeBackIsWired.test.ts` asserts the write-back.
 *
 * Two roots, not three: the preview server boots through the dashboard harness
 * (`startPreview` → `bootBotForDashboard`), which the last case pins.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

function read(...segments: string[]): string {
    return readFileSync(join(REPO, ...segments), 'utf8');
}

const REGISTERS = /registerTicketTypeProvisioning\(\s*\)/;

describe('ticket type provisioning is reachable', () => {
    it('is registered by the bot, through initTicketsFeature', () => {
        expect(read('src', 'features', 'tickets', 'initTicketsFeature.ts')).toMatch(REGISTERS);
        expect(read('src', 'bot.ts')).toMatch(/initTicketsFeature\(\s*\)/);
    });

    it('is registered by the dashboard boot that e2e and the preview server share', () => {
        expect(read('web', 'e2e', 'support', 'bootBot.ts')).toMatch(REGISTERS);
        expect(read('web', 'e2e', 'preview', 'startPreview.ts')).toMatch(/bootBotForDashboard\(\s*\)/);
    });

    it('registers the ticket feature’s implementation with provisioning', () => {
        expect(read('src', 'features', 'tickets', 'logic', 'ticketTypeProvisioning.ts')).toMatch(
            /registerTicketTypeProvider\(\s*ticketTypeProvisioning\s*\)/
        );
    });

    it('is asked by install, to plan and to apply', () => {
        expect(read('src', 'features', 'provisioning', 'provisioningService.ts')).toMatch(
            /requireTicketTypeProvider\(\)\.read\(/
        );
        expect(read('src', 'features', 'provisioning', 'logic', 'applyInstallPlan.ts')).toMatch(
            /requireTicketTypeProvider\(\)\.createIfAbsent\(/
        );
    });
});
