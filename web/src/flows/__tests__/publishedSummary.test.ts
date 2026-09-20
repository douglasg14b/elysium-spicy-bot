import { describe, expect, it } from 'vitest';
import type { PublishedFlowState, PublishedResource } from '../../api/types';
import { summarisePublished, unpublishConfirmLine } from '../publishedSummary';

/**
 * What the delete dialog tells an operator.
 *
 * The property worth guarding: a refusal is never summarised into a count. It is the
 * reason the preview exists, and "1 item cannot be removed" is exactly the unactionable
 * line this whole design was meant to avoid.
 */

function state(overrides: Partial<PublishedFlowState> = {}): PublishedFlowState {
    return {
        buttonMessages: [],
        deletableResources: [],
        refusedResources: [],
        mayHaveUnrecordedButtons: true,
        ...overrides,
    };
}

function resource(overrides: Partial<PublishedResource> = {}): PublishedResource {
    return {
        resourceKey: 'chan',
        kind: 'textChannel',
        name: 'tickets',
        refused: false,
        ...overrides,
    };
}

describe('summarising what is published', () => {
    it('reports nothing to warn about for a flow that published nothing', () => {
        const summary = summarisePublished(state());

        expect(summary.hasAnything).toBe(false);
        expect(summary.leftBehind).toBeNull();
        expect(summary.canUndeploy).toBe(false);
        expect(summary.canUnpublish).toBe(false);
    });

    it('names button messages and resources by kind rather than as a count of things', () => {
        const summary = summarisePublished(
            state({
                buttonMessages: [{ channelId: 'c1', messageId: 'm1', nodeIds: ['n1'] }],
                deletableResources: [
                    resource({ resourceKey: 'a', kind: 'textChannel' }),
                    resource({ resourceKey: 'b', kind: 'textChannel' }),
                    resource({ resourceKey: 'r', kind: 'role', name: 'Helper' }),
                ],
            })
        );

        expect(summary.hasAnything).toBe(true);
        // "2 channels and 1 role", not "3 resources" — an operator can picture one.
        expect(summary.leftBehind).toContain('2 channels');
        expect(summary.leftBehind).toContain('1 role');
        expect(summary.leftBehind).toContain('1 button message');
        expect(summary.canUndeploy).toBe(true);
        expect(summary.canUnpublish).toBe(true);
    });

    it('pluralises categories without an "s"', () => {
        const summary = summarisePublished(
            state({
                deletableResources: [
                    resource({ resourceKey: 'c1', kind: 'category', name: 'One' }),
                    resource({ resourceKey: 'c2', kind: 'category', name: 'Two' }),
                ],
            })
        );

        expect(summary.leftBehind).toContain('2 categories');
    });

    it('keeps every refusal as its own line, with its reason', () => {
        const summary = summarisePublished(
            state({
                refusedResources: [
                    resource({
                        resourceKey: 'theirs',
                        name: 'announcements',
                        refused: true,
                        explanation: 'This channel already existed and was adopted, not created.',
                    }),
                    resource({
                        resourceKey: 'cat',
                        kind: 'category',
                        name: 'Support',
                        refused: true,
                        explanation: 'Deleting the category Support would also delete general.',
                    }),
                ],
            })
        );

        expect(summary.refusals).toHaveLength(2);
        expect(summary.refusals[0]).toContain('adopted');
        expect(summary.refusals[1]).toContain('general');
        // A refusal-only flow still has something to say.
        expect(summary.hasAnything).toBe(true);
    });

    it('does not offer unpublish when everything would be refused', () => {
        // Offering a destructive button that can only refuse is worse than not
        // offering it: the operator clicks it, nothing happens, and they learn to
        // distrust the dialog.
        const summary = summarisePublished(
            state({
                refusedResources: [resource({ refused: true, explanation: 'Adopted.' })],
            })
        );

        expect(summary.canUnpublish).toBe(false);
        expect(summary.refusals).toHaveLength(1);
    });

    it('always warns that older buttons cannot be found', () => {
        // The table was not backfilled and cannot be. An empty list must not be read
        // as "nothing is published".
        const summary = summarisePublished(state());

        expect(summary.unrecordedWarning).toContain('cannot be cleaned up automatically');
    });
});

describe('the confirm line for an irreversible teardown', () => {
    it('names what is about to be destroyed rather than gesturing at it', () => {
        const line = unpublishConfirmLine([
            resource({ resourceKey: 'a', kind: 'textChannel' }),
            resource({ resourceKey: 'c', kind: 'category', name: 'Support' }),
        ]);

        expect(line).toContain('1 channel');
        expect(line).toContain('1 category');
        expect(line).toContain('for good');
    });

    it('says so plainly when there is nothing to delete', () => {
        expect(unpublishConfirmLine([])).toContain('nothing to delete');
    });
});
