import { describe, expect, it } from 'vitest';
import type { PublishedFlowState, PublishedResource } from '../../api/types';
import {
    summarisePublished,
    type PublishedResourceLine,
    type PublishedSummary,
} from '../publishedSummary';

/** Every row the dialog would draw, in reading order, ignoring the grouping. */
function allLines(summary: PublishedSummary): readonly PublishedResourceLine[] {
    return summary.groups.flatMap((group) => group.lines);
}

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

        const kept = allLines(summary).filter((line) => line.fate === 'kept');
        expect(kept).toHaveLength(2);
        expect(kept[0].explanation).toContain('adopted');
        expect(kept[1].explanation).toContain('general');
        // A refusal-only flow still has something to say.
        expect(summary.hasAnything).toBe(true);
    });

    it('names every resource individually rather than only counting them', () => {
        // The defect this guards: the dialog showed "1 channel and 1 category" and an
        // operator could not tell what the destructive button was about to take.
        const summary = summarisePublished(
            state({
                deletableResources: [
                    resource({ resourceKey: 'chan', kind: 'textChannel', name: 'ticket-desk' }),
                    resource({ resourceKey: 'cat', kind: 'category', name: 'Support' }),
                ],
            })
        );

        const lines = allLines(summary);
        expect(lines).toHaveLength(2);
        expect(lines[0].displayName).toBe('#ticket-desk');
        expect(lines[0].kindLabel).toBe('channel');
        expect(lines[1].displayName).toBe('Support');
        expect(lines[1].kindLabel).toBe('category');
    });

    it('takes its prefixes from the shared kind table, so a role reads @Helper', () => {
        // Prefixes come from `RESOURCE_KIND_STYLES`, which is what the resources panel
        // and the pickers draw from. A name must read the same wherever it appears.
        const summary = summarisePublished(
            state({ deletableResources: [resource({ kind: 'role', name: 'Helper' })] })
        );

        expect(allLines(summary)[0].displayName).toBe('@Helper');
        expect(allLines(summary)[0].kindLabel).toBe('role');
    });

    it('shows an unrecognised kind rather than dropping it or inventing punctuation', () => {
        // A kind this build has not heard of is still a real thing about to be deleted.
        const summary = summarisePublished(
            state({ deletableResources: [resource({ kind: 'forumChannel', name: 'ideas' })] })
        );

        const line = allLines(summary)[0];
        expect(line.displayName).toBe('ideas');
        expect(line.kindLabel).toBe('forumChannel');
        expect(line.glyph).toBe('unknown');
    });

    it('splits resources into groups by fate, with the destructive group first', () => {
        const summary = summarisePublished(
            state({
                deletableResources: [resource({ resourceKey: 'mine', name: 'mine' })],
                refusedResources: [
                    resource({
                        resourceKey: 'theirs',
                        name: 'theirs',
                        refused: true,
                        explanation: 'Adopted, not created.',
                    }),
                ],
                buttonMessages: [{ channelId: 'c1', messageId: 'm1', nodeIds: ['n1', 'n2'] }],
            })
        );

        // The group order is the reading order: what dies, then what survives.
        expect(summary.groups.map((group) => group.id)).toEqual([
            'created',
            'adopted',
            'messages',
        ]);
        expect(summary.groups[0].destructive).toBe(true);
        expect(summary.groups[1].destructive).toBe(false);
        expect(summary.groups[2].lines[0].displayName).toBe('2 buttons posted');
    });

    it('drops empty groups rather than showing a heading over nothing', () => {
        const summary = summarisePublished(
            state({ deletableResources: [resource({ name: 'only-this' })] })
        );

        expect(summary.groups.map((group) => group.id)).toEqual(['created']);
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
        expect(summary.groups.map((group) => group.id)).toEqual(['adopted']);
        expect(allLines(summary)[0].fate).toBe('kept');
    });

    it('reports the button count so the dialog can mention buttons only when there are some', () => {
        // The standing "older buttons may be invisible" caveat was removed: it was
        // hardcoded on for every flow, including flows with no buttons at all, and so
        // read as boilerplate rather than as a warning.
        expect(summarisePublished(state()).buttonCount).toBe(0);
        expect(
            summarisePublished(
                state({ buttonMessages: [{ channelId: 'c1', messageId: 'm1', nodeIds: ['n1'] }] })
            ).buttonCount
        ).toBe(1);
    });
});

describe('the label on the button that destroys things', () => {
    it('carries its own count, because there is no confirmation card behind it', () => {
        // The card that used to restate this was removed for repeating the list above
        // it. The count moved onto the button, which is now the whole warning.
        const summary = summarisePublished(
            state({
                deletableResources: [
                    resource({ resourceKey: 'a', name: 'one' }),
                    resource({ resourceKey: 'b', name: 'two' }),
                ],
            })
        );

        expect(summary.deletableCount).toBe(2);
        expect(summary.unpublishLabel).toBe('Delete 2 resources');
        expect(summary.unpublishConfirmLabel).toBe('Yes, delete 2 resources');
    });

    it('stays singular for one resource', () => {
        const summary = summarisePublished(
            state({ deletableResources: [resource({ name: 'lonely' })] })
        );

        expect(summary.unpublishLabel).toBe('Delete 1 resource');
        expect(summary.unpublishConfirmLabel).toBe('Yes, delete 1 resource');
    });
});
