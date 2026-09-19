import { describe, expect, it } from 'vitest';
import {
    ResourceDeclarationError,
    orderResourcesForApply,
    validateJourneyDeclaration,
    type JourneyDeclaration,
    type ResourceDeclaration,
} from '../resourceDeclaration';

/**
 * Declaration validation, which runs before anything touches the guild.
 *
 * Every rejection here is one that would otherwise surface mid-apply with resources
 * already created — the half-applied state the whole crash-safety design exists to
 * avoid. Catching it up front is far cheaper than unwinding.
 */

function journey(resources: ResourceDeclaration[]): JourneyDeclaration {
    return { journeyKey: 'onboarding', name: 'Onboarding', resources };
}

describe('validateJourneyDeclaration', () => {
    it('accepts a category with a child channel and a standalone role', () => {
        expect(() =>
            validateJourneyDeclaration(
                journey([
                    { key: 'cat', kind: 'category', defaultName: 'Arrivals' },
                    { key: 'chan', kind: 'textChannel', defaultName: 'welcome', parentKey: 'cat' },
                    { key: 'role', kind: 'role', defaultName: 'Verified' },
                ])
            )
        ).not.toThrow();
    });

    it('rejects a journey declaring nothing', () => {
        expect(() => validateJourneyDeclaration(journey([]))).toThrow(ResourceDeclarationError);
    });

    it('rejects a duplicate resource key', () => {
        // A key must resolve to exactly one binding; the unique index would reject
        // the second insert mid-apply, after the first resource was already created.
        expect(() =>
            validateJourneyDeclaration(
                journey([
                    { key: 'chan', kind: 'textChannel', defaultName: 'welcome' },
                    { key: 'chan', kind: 'textChannel', defaultName: 'rules' },
                ])
            )
        ).toThrow(/more than once/i);
    });

    it('rejects a parent the journey does not declare', () => {
        expect(() =>
            validateJourneyDeclaration(
                journey([
                    { key: 'chan', kind: 'textChannel', defaultName: 'welcome', parentKey: 'ghost' },
                ])
            )
        ).toThrow(/does not declare/i);
    });

    it('rejects a parent that is not a category', () => {
        expect(() =>
            validateJourneyDeclaration(
                journey([
                    { key: 'other', kind: 'textChannel', defaultName: 'rules' },
                    { key: 'chan', kind: 'textChannel', defaultName: 'welcome', parentKey: 'other' },
                ])
            )
        ).toThrow(/Only a category can be a parent/i);
    });

    it('rejects a role with a parent', () => {
        expect(() =>
            validateJourneyDeclaration(
                journey([
                    { key: 'cat', kind: 'category', defaultName: 'Arrivals' },
                    { key: 'role', kind: 'role', defaultName: 'Verified', parentKey: 'cat' },
                ])
            )
        ).toThrow(/do not live under categories/i);
    });
});

describe('orderResourcesForApply', () => {
    it('puts a parent before its child regardless of declaration order', () => {
        const ordered = orderResourcesForApply([
            { key: 'chan', kind: 'textChannel', defaultName: 'welcome', parentKey: 'cat' },
            { key: 'cat', kind: 'category', defaultName: 'Arrivals' },
        ]);

        expect(ordered.map((resource) => resource.key)).toEqual(['cat', 'chan']);
    });

    it('keeps every resource exactly once', () => {
        const input: ResourceDeclaration[] = [
            { key: 'cat', kind: 'category', defaultName: 'Arrivals' },
            { key: 'a', kind: 'textChannel', defaultName: 'a', parentKey: 'cat' },
            { key: 'b', kind: 'textChannel', defaultName: 'b', parentKey: 'cat' },
            { key: 'role', kind: 'role', defaultName: 'Verified' },
        ];

        const ordered = orderResourcesForApply(input);

        expect(ordered).toHaveLength(4);
        expect(new Set(ordered.map((resource) => resource.key)).size).toBe(4);
    });

    it('names the participants in a parent cycle rather than hanging', () => {
        // Unreachable through validation, which rejects unknown parents first — but
        // an infinite loop here would be a hang with no diagnostic at all.
        expect(() =>
            orderResourcesForApply([
                { key: 'a', kind: 'textChannel', defaultName: 'a', parentKey: 'b' },
                { key: 'b', kind: 'textChannel', defaultName: 'b', parentKey: 'a' },
            ])
        ).toThrow(/cycle/i);
    });
});
