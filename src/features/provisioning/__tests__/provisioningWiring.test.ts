import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import {
    INSTALL_JOURNEY_APPLY_ID,
    buildInstallJourneyCommand,
} from '../commands/installJourneyCommand';

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

describe('provisioning is wired into the bot', () => {
    it('registers the /install-journey slash command', () => {
        expect(BOT_SOURCE).toMatch(/interactionsRegistry\.register\(\s*buildInstallJourneyCommand\(\)/);
    });

    it('calls initProvisioning, which registers the apply button', () => {
        expect(BOT_SOURCE).toMatch(/initProvisioning\(\)/);
    });

    it('imports from the feature barrel rather than deep paths', () => {
        // Deep imports work and then rot; the barrel is the supported entry point.
        expect(BOT_SOURCE).toMatch(/from '\.\/features\/provisioning'/);
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

describe('the install command surface', () => {
    it('is named so an operator can find it', () => {
        expect(buildInstallJourneyCommand().name).toBe('install-journey');
    });

    it('takes a free-text journey key rather than a fixed choice list', () => {
        // Journeys are per-guild rows; slash commands are registered globally once.
        // A static choice list could never reflect this guild's journeys, which is
        // why this command is scheduled for deletion in favour of the dashboard.
        const json = buildInstallJourneyCommand().toJSON();
        const journeyOption = json.options?.find((option) => option.name === 'journey');

        expect(journeyOption).toBeDefined();
        expect((journeyOption as { choices?: unknown[] } | undefined)?.choices).toBeUndefined();
    });

    it('requires Manage Server', () => {
        // Provisioning mutates guild structure; it must not be open to everyone.
        expect(buildInstallJourneyCommand().toJSON().default_member_permissions).toBeTruthy();
    });

    it('leaves room for a journey key within the 100-character custom id limit', () => {
        // The apply button's custom id is `${APPLY_ID}:${journeyKey}` plus staff role
        // ids. The prefix has to be short enough that a realistic key still fits.
        expect(`${INSTALL_JOURNEY_APPLY_ID}:`.length).toBeLessThan(40);
    });
});

describe('the engine ships no journeys of its own', () => {
    it('registers no journey at startup', async () => {
        // The point of the whole authoring change: a fresh install has zero journeys
        // until an operator creates one. A bundled journey re-registered here would
        // silently restore the hardcoded-journey behaviour this replaced.
        const initSource = readFileSync(
            join(dirname(fileURLToPath(import.meta.url)), '..', 'initProvisioning.ts'),
            'utf8'
        );

        expect(initSource).not.toMatch(/registerJourney/);
        expect(initSource).not.toMatch(/JOURNEY\b/);
    });
});
