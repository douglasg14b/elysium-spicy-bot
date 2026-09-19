import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { INSTALL_JOURNEY_APPLY_ID, installJourneyCommand } from '../commands/installJourneyCommand';
import { JOURNEYS, ONBOARDING_JOURNEY } from '../journeys/onboardingJourney';
import { validateJourneyDeclaration } from '../logic/resourceDeclaration';

/**
 * That provisioning is reachable at run time.
 *
 * This repo has four precedents for a symbol that was written, exported, typechecked
 * and never wired to anything — `incrementTicketNumber`, `ticketChannelValidation`,
 * `ticketCommands.ts`, and `BLOCK_CAPABILITIES`. One of them reached a test plan as a
 * live step before anyone noticed. A green suite proves nothing about reachability,
 * so reachability is asserted directly.
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

describe('provisioning is wired into the bot', () => {
    it('registers the /install-journey slash command', () => {
        expect(BOT_SOURCE).toMatch(/interactionsRegistry\.register\(\s*installJourneyCommand/);
    });

    it('calls initProvisioning, which registers the apply button', () => {
        expect(BOT_SOURCE).toMatch(/initProvisioning\(\)/);
    });

    it('imports both from the feature barrel rather than deep paths', () => {
        // Deep imports work and then rot; the barrel is the supported entry point.
        expect(BOT_SOURCE).toMatch(/from '\.\/features\/provisioning'/);
    });
});

describe('the install command surface', () => {
    it('is named so an operator can find it', () => {
        expect(installJourneyCommand.name).toBe('install-journey');
    });

    it('offers every known journey as a choice', () => {
        const json = installJourneyCommand.toJSON();
        const journeyOption = json.options?.find((option) => option.name === 'journey');
        const choices = (journeyOption as { choices?: { value: string }[] } | undefined)?.choices ?? [];

        expect(choices.map((choice) => choice.value).sort()).toEqual([...JOURNEYS.keys()].sort());
    });

    it('requires Manage Server', () => {
        // Provisioning mutates guild structure; it must not be open to everyone.
        expect(installJourneyCommand.toJSON().default_member_permissions).toBeTruthy();
    });

    it('keeps the apply custom id within the 100-character Discord limit', () => {
        for (const journeyKey of JOURNEYS.keys()) {
            expect(`${INSTALL_JOURNEY_APPLY_ID}:${journeyKey}`.length).toBeLessThanOrEqual(100);
        }
    });
});

describe('the onboarding journey declaration', () => {
    it('is internally consistent', () => {
        expect(() => validateJourneyDeclaration(ONBOARDING_JOURNEY)).not.toThrow();
    });

    it('declares the role the onboarding flow assigns', () => {
        // `buildOnboardingFlowGraph` takes a memberRoleId; provisioning is what
        // supplies it once write-back runs.
        const role = ONBOARDING_JOURNEY.resources.find((resource) => resource.kind === 'role');
        expect(role?.key).toBe('member-role');
    });

    it('puts its channels under the category it declares', () => {
        const category = ONBOARDING_JOURNEY.resources.find(
            (resource) => resource.kind === 'category'
        );
        const channels = ONBOARDING_JOURNEY.resources.filter(
            (resource) => resource.kind === 'textChannel'
        );

        expect(channels.length).toBeGreaterThan(0);
        for (const channel of channels) {
            expect(channel.parentKey).toBe(category?.key);
        }
    });

    it('makes the rules channel read-only for everyone', () => {
        // The agree button is posted there; a channel anyone can post in turns the
        // rules into a conversation.
        const rules = ONBOARDING_JOURNEY.resources.find(
            (resource) => resource.key === 'rules-channel'
        );

        expect(rules?.permissions).toEqual([{ audience: 'everyone', access: 'readOnly' }]);
    });
});
