import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * That provisioning is reachable at run time.
 *
 * This repo has five precedents for a symbol that was written, exported, typechecked
 * and never wired to anything — `incrementTicketNumber`, `ticketChannelValidation`,
 * `ticketCommands.ts`, `BLOCK_CAPABILITIES`, and `resolveJourneyResources`. One of
 * them reached a test plan as a live step before anyone noticed. A green suite proves
 * nothing about reachability, so reachability is asserted directly.
 *
 * Reading `bot.ts` as text is deliberately crude. Importing it would boot the bot —
 * Discord client, web server, schedulers — which a unit test must not do.
 */

// Resolved from this file rather than `process.cwd()`, so the test does not depend on
// where the runner was invoked from.
const BOT_SOURCE = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'bot.ts'),
    'utf8'
);

const API_SOURCE = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web', 'api', 'index.ts'),
    'utf8'
);

/**
 * Strip comments before asserting a symbol is *absent*.
 *
 * `bot.ts` explains in prose why provisioning has no Discord surface, and that prose
 * has to be free to name the thing it is explaining. Matching raw source would turn
 * "document the deletion" into a failing test, whose obvious fix is to delete the
 * explanation — the opposite of what these assertions are protecting.
 */
function codeOf(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
}

const BOT_CODE = codeOf(BOT_SOURCE);

describe('provisioning has no Discord surface', () => {
    /*
     * The inverse of what this block used to assert.
     *
     * `/install-journey` and its Apply button were the only way the bot itself could
     * mutate a guild's channels and roles, and they were deleted once the dashboard
     * could install: journeys are per-guild rows while slash commands register
     * globally, so a command could never offer a real picker. Asserted rather than
     * assumed because re-adding a Discord install path would quietly restore a second
     * way to provision — the thing the dashboard was built to replace.
     */
    it('registers no provisioning command or component in bot.ts', () => {
        expect(BOT_CODE).not.toMatch(/InstallJourney/);
        expect(BOT_CODE).not.toMatch(/initProvisioning/);
        expect(BOT_CODE).not.toMatch(/provisioning:apply/);
    });

    it('offers no install handler from the feature barrel', () => {
        // A barrel export is how a deleted surface comes back by accident: something
        // exported and then wired, rather than written from scratch.
        const barrel = readFileSync(
            join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'),
            'utf8'
        );

        const barrelCode = codeOf(barrel);

        expect(barrelCode).not.toMatch(/handleInstallJourney|buildInstallJourneyCommand/);
        expect(barrelCode).not.toMatch(/initProvisioning/);
    });
});

describe('journey authoring is reachable', () => {
    it('mounts the journey routes under the guild-scoped API group', () => {
        // The routes are the only way an operator can create a journey. Written and
        // unmounted, the whole authoring surface would be unreachable while every
        // unit test still passed — the exact failure this file exists to catch.
        expect(API_SOURCE).toMatch(/journeyRoutes\(\)/);
        expect(API_SOURCE).toMatch(/app\.route\('\/api\/guilds', journeyRoutes\(\)\)/);
    });
});

describe('the engine ships no journeys of its own', () => {
    it('has no startup hook a journey could be registered in', () => {
        // The point of the whole authoring change: a fresh install has zero journeys
        // until an operator creates one. `initProvisioning` used to be checked for a
        // bundled registration; it was deleted with the Discord surface, so the
        // property now holds for a stronger reason — provisioning runs nothing at
        // startup, and bot.ts is where a re-added hook would have to appear.
        expect(BOT_CODE).not.toMatch(/registerJourney/);
    });
});
