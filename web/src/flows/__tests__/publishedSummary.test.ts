import { describe, expect, it } from 'vitest';
import type { PublishedFlowState, PublishedResource } from '@brattybot/web-sdk';
import {
    installedFromPublished,
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
        deletableResources: [],
        refusedResources: [],
        keptSettings: [],
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
        expect(summary.canUnpublish).toBe(false);
    });

    it('names resources by kind rather than as a count of things', () => {
        const summary = summarisePublished(
            state({
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
                        refusalReason: 'adopted',
                        explanation: 'Adopted, not created.',
                    }),
                ],
            })
        );

        // The group order is the reading order: what dies, then what survives.
        expect(summary.groups.map((group) => group.id)).toEqual(['created', 'adopted']);
        expect(summary.groups[0].destructive).toBe(true);
        expect(summary.groups[1].destructive).toBe(false);
    });

    it('draws a posted message resource from the shared kind table, as the rows beside it are', () => {
        // A journey's message is deleted by an uninstall like any other resource, so it
        // sits under "Created by this flow" wearing the kind's own glyph.
        const summary = summarisePublished(
            state({ deletableResources: [resource({ resourceKey: 'rules-panel', kind: 'message', name: 'Rules panel' })] })
        );

        expect(summary.groups.map((group) => group.id)).toEqual(['created']);
        expect(allLines(summary)[0]).toMatchObject({ glyph: 'message', kindLabel: 'message', fate: 'deleted' });
    });

    it('does not call a created-but-blocked category "adopted"', () => {
        /*
         * The defect this guards, seen in a real server: a category this flow created
         * was refused because someone had since added a channel inside it, and the
         * dialog filed it under "Adopted, not created" — telling the operator the flow
         * had not made a thing it had made. The two refusals mean opposite things about
         * ownership, so they cannot share a heading.
         */
        const summary = summarisePublished(
            state({
                refusedResources: [
                    resource({
                        resourceKey: 'cat',
                        kind: 'category',
                        name: 'test stuff',
                        refused: true,
                        refusalReason: 'category-has-survivors',
                        survivors: ['general'],
                        explanation: 'Deleting the category **test stuff** would also…',
                    }),
                    resource({
                        resourceKey: 'theirs',
                        name: 'announcements',
                        refused: true,
                        refusalReason: 'adopted',
                        explanation: 'This channel already existed and was adopted.',
                    }),
                ],
            })
        );

        const blocked = summary.groups.find((group) => group.id === 'blocked');
        const adopted = summary.groups.find((group) => group.id === 'adopted');

        expect(blocked?.lines.map((line) => line.displayName)).toEqual(['test stuff']);
        expect(adopted?.lines.map((line) => line.displayName)).toEqual(['#announcements']);
        // The heading over a resource this flow built must not deny that it built it.
        expect(blocked?.title).not.toMatch(/adopted/i);
    });

    it('files a permission or hierarchy refusal with the blocked group, not the adopted one', () => {
        // Anything that is not `adopted` was created by this flow and is being held
        // back, so the fallback has to be "blocked" rather than "adopted".
        const summary = summarisePublished(
            state({
                refusedResources: [
                    resource({
                        refused: true,
                        refusalReason: 'missing-permission',
                        explanation: 'The bot cannot manage this channel.',
                    }),
                ],
            })
        );

        expect(summary.groups.map((group) => group.id)).toEqual(['blocked']);
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
                refusedResources: [
                    resource({ refused: true, refusalReason: 'adopted', explanation: 'Adopted.' }),
                ],
            })
        );

        expect(summary.canUnpublish).toBe(false);
        expect(summary.groups.map((group) => group.id)).toEqual(['adopted']);
        expect(allLines(summary)[0].fate).toBe('kept');
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

/**
 * The two places this copy names its **owner** rather than its resources.
 *
 * Both were written when only a flow could own resources, and both say something false
 * on a group header: the journey's channels were created by several flows, not by the
 * one the operator happens to have in mind. The rest of the module is scope-neutral,
 * which is why this is a discriminator rather than a second module.
 */
describe('scope-aware wording', () => {
    const published = state({
        deletableResources: [resource({ resourceKey: 'a', name: 'tickets' })],
    });

    it('attributes resources to the flow by default', () => {
        const summary = summarisePublished(published);

        expect(summary.leftBehind).toContain('it created');
        expect(summary.groups[0].title).toBe('Created by this flow');
    });

    it('attributes them to the group when summarising a journey', () => {
        const summary = summarisePublished(published, 'journey');

        expect(summary.leftBehind).toContain('they created');
        expect(summary.leftBehind).not.toContain('it created');
        expect(summary.groups[0].title).toBe('Created by these flows');
    });

    /**
     * Only the ownership wording moves. The inventory is the same list of the same
     * resources either way, and a scope that quietly changed which rows appeared would
     * be a dialog showing one thing and destroying another.
     */
    it('changes nothing else about the inventory', () => {
        const asFlow = summarisePublished(published);
        const asJourney = summarisePublished(published, 'journey');

        expect(allLines(asJourney)).toEqual(allLines(asFlow));
        expect(asJourney.deletableCount).toBe(asFlow.deletableCount);
        expect(asJourney.unpublishLabel).toBe(asFlow.unpublishLabel);
        expect(asJourney.canUnpublish).toBe(asFlow.canUnpublish);
    });
});

describe('what the builder takes from a published read', () => {
    const live = state({
        deletableResources: [resource({ resourceKey: 'lounge' })],
        refusedResources: [resource({ resourceKey: 'adopted-rules', refused: true, refusalReason: 'adopted' })],
    });

    it('counts and keys every live resource, refused ones included', () => {
        const view = installedFromPublished({ data: live, failed: false });
        expect(view.count).toBe(2);
        expect([...view.keys].sort()).toEqual(['adopted-rules', 'lounge']);
    });

    it('maps each live resource that names a Discord id to its key', () => {
        const view = installedFromPublished({
            data: state({
                deletableResources: [resource({ resourceKey: 'lounge', discordId: '700' })],
                refusedResources: [resource({ resourceKey: 'adopted-rules', refused: true, refusalReason: 'adopted', discordId: '701' })],
                keptSettings: [resource({ resourceKey: 'front-desk', kind: 'ticketType' })],
            }),
            failed: false,
        });
        expect([...view.keysByDiscordId]).toEqual([
            ['700', 'lounge'],
            ['701', 'adopted-rules'],
        ]);
    });

    it('counts a ticket type uninstall would only forget as installed', () => {
        // Left out, a journey holding only a ticket type read as not installed, with no
        // uninstall in reach — and its key would follow the label again.
        const view = installedFromPublished({
            data: state({ keptSettings: [resource({ resourceKey: 'front-desk', kind: 'ticketType' })] }),
            failed: false,
        });
        expect(view.count).toBe(1);
        expect([...view.keys]).toEqual(['front-desk']);
    });

    it('knows nothing before the first answer', () => {
        const view = installedFromPublished({ data: undefined, failed: false });
        expect(view.count).toBeNull();
        expect(view.keys.size).toBe(0);
    });

    it('forgets the count but keeps the keys when a refresh fails', () => {
        // The query keeps its last answer through a failed refetch. Releasing the keys
        // would let a rename move a key something in the guild is bound to.
        const view = installedFromPublished({ data: live, failed: true });
        expect(view.count).toBeNull();
        expect([...view.keys].sort()).toEqual(['adopted-rules', 'lounge']);
    });
});

describe('a ticket type the journey installed', () => {
    const keptType = resource({
        resourceKey: 'front-desk',
        kind: 'ticketType',
        name: 'Front desk',
        explanation: 'The ticket type **Front desk** stays, and flows that use it keep working.',
    });

    it('is listed as kept, with the server’s sentence, and uninstall is still offered when it is all there is', () => {
        const summary = summarisePublished(state({ keptSettings: [keptType] }));

        expect(summary.hasAnything).toBe(true);
        expect(summary.groups.map((group) => group.id)).toEqual(['settings']);
        expect(summary.groups[0]?.lines[0]).toMatchObject({
            fate: 'kept',
            kindLabel: 'ticket type',
            displayName: 'Front desk',
            explanation: keptType.explanation,
        });
        expect(summary.canUnpublish).toBe(true);
        // Never "Delete 0 resources".
        expect(summary.unpublishLabel).toBe('Uninstall, keeping 1 setting');
        expect(summary.unpublishConfirmLabel).toBe('Yes, uninstall');
    });

    it('leaves the count on the button to the deletions when there are some', () => {
        const summary = summarisePublished(state({ deletableResources: [resource()], keptSettings: [keptType] }));

        expect(summary.unpublishLabel).toBe('Delete 1 resource');
        expect(summary.deletableCount).toBe(1);
    });
});
