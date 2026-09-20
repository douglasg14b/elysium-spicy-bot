import { describe, expect, it } from 'vitest';
import {
    kindLabel,
    summariseInstallFailure,
    summariseInstallOutcome,
    summariseInstallPlan,
} from '../installSummary';
import type { InstallPlan, InstallPlanItem, InstallResult, ResourceKind } from '../../api/types';

/**
 * What the install dialog decides, tested where the decisions live.
 *
 * `web/` has no jsdom, so the component is deliberately a renderer over this module —
 * the same arrangement `publishedSummary.test.ts` beside this one tests.
 */

function item(overrides: Partial<InstallPlanItem> = {}): InstallPlanItem {
    return {
        resourceKey: 'qa-channel',
        kind: 'textChannel',
        action: 'create',
        name: 'questions',
        ...overrides,
    };
}

function plan(overrides: Partial<InstallPlan> = {}): InstallPlan {
    return {
        journeyKey: 'flow-1',
        applicable: true,
        blockers: [],
        items: [item()],
        ...overrides,
    };
}

function result(overrides: Partial<InstallResult> = {}): InstallResult {
    return {
        applied: [
            { resourceKey: 'qa-channel', discordId: '111', action: 'created', name: 'questions' },
        ],
        writtenCount: 0,
        updatedFlowIds: [],
        unresolved: [],
        writeBackFailed: false,
        ...overrides,
    };
}

describe('naming a single resource by kind', () => {
    it('calls a category a category, not a channel', () => {
        // The bug this replaces: a two-way role/channel check in JSX announced
        // "Create channel Archive" while the headline beside it said "1 category".
        expect(kindLabel('category')).toBe('category');
    });

    it('names each kind of the closed union', () => {
        const labels: Record<ResourceKind, string> = {
            category: kindLabel('category'),
            textChannel: kindLabel('textChannel'),
            role: kindLabel('role'),
        };

        expect(labels).toEqual({
            category: 'category',
            textChannel: 'channel',
            role: 'role',
        });
    });

    it('agrees with the counted headline on what a thing is called', () => {
        // One noun table, so the list and the line above it cannot disagree.
        const summary = summariseInstallPlan(
            plan({ items: [item({ kind: 'category', name: 'Archive' })] })
        );

        expect(summary.headline).toContain(`1 ${kindLabel('category')}`);
    });
});

describe('summarising a plan for review', () => {
    it('counts by kind rather than saying "3 resources"', () => {
        const summary = summariseInstallPlan(
            plan({
                items: [
                    item({ resourceKey: 'a', kind: 'textChannel', name: 'questions' }),
                    item({ resourceKey: 'b', kind: 'textChannel', name: 'answers' }),
                    item({ resourceKey: 'c', kind: 'role', name: 'Helper' }),
                ],
            })
        );

        // "2 channels and 1 role", matching the teardown copy's counting beside it.
        expect(summary.headline).toBe('This will create 2 channels and 1 role in your server.');
    });

    it('separates adopting from creating, because they do different things to a server', () => {
        const summary = summariseInstallPlan(
            plan({
                items: [
                    item({ resourceKey: 'a', action: 'create', name: 'questions' }),
                    item({ resourceKey: 'b', action: 'adopt', kind: 'role', name: 'Helper' }),
                ],
            })
        );

        expect(summary.headline).toContain('create 1 channel');
        expect(summary.headline).toContain('adopt 1 role');
        expect(summary.changes).toHaveLength(2);
    });

    it('lists the already-bound items as unchanged rather than dropping them', () => {
        // "What will this do to my server" is only answerable if what it will leave
        // alone is visible too.
        const summary = summariseInstallPlan(
            plan({
                items: [
                    item({ resourceKey: 'a', action: 'create' }),
                    item({ resourceKey: 'b', action: 'reuse', name: 'Archive', kind: 'category' }),
                ],
            })
        );

        expect(summary.unchanged.map((entry) => entry.name)).toEqual(['Archive']);
        expect(summary.changes).toHaveLength(1);
    });

    it('names every problem individually, blockers and blocked items alike', () => {
        // A count is not something an operator can act on; the sentence naming the
        // channel is.
        const summary = summariseInstallPlan(
            plan({
                applicable: false,
                blockers: ['The bot lacks **Manage Channels**.'],
                items: [
                    item({
                        action: 'blocked',
                        reason: 'A channel named "questions" already exists.',
                    }),
                ],
            })
        );

        expect(summary.problems).toEqual([
            'The bot lacks **Manage Channels**.',
            'A channel named "questions" already exists.',
        ]);
        expect(summary.canApply).toBe(false);
    });

    it('falls back to naming a blocked item when the server sent no reason', () => {
        const summary = summariseInstallPlan(
            plan({ applicable: false, items: [item({ action: 'blocked', reason: undefined })] })
        );

        expect(summary.problems[0]).toContain('questions');
    });

    it('offers no confirm when everything is already in place', () => {
        const summary = summariseInstallPlan(
            plan({ items: [item({ action: 'reuse', discordId: '111' })] })
        );

        expect(summary.canApply).toBe(false);
        expect(summary.headline).toBeNull();
        expect(summary.problems).toEqual([]);
    });

    it('follows the server on applicability rather than re-deriving it', () => {
        // The server re-checks on apply regardless. A browser with its own opinion
        // would eventually offer a button that 409s.
        const summary = summariseInstallPlan(plan({ applicable: false }));

        expect(summary.canApply).toBe(false);
    });

    it('keeps an unrecognised kind rather than dropping it', () => {
        const summary = summariseInstallPlan(
            plan({ items: [item({ kind: 'voiceChannel' as InstallPlanItem['kind'] })] })
        );

        expect(summary.headline).toContain('voiceChannel');
    });
});

describe('summarising what an install did', () => {
    it('reports a partial install as partial, not as a failure', () => {
        const summary = summariseInstallOutcome(
            result({ failure: 'Discord refused to create the role: Missing Permissions.' })
        );

        expect(summary.tone).toBe('orange');
        expect(summary.title).toBe('Stopped partway');
        // What was created is real and bound — the copy must not imply otherwise.
        expect(summary.message).toContain('1 thing');
        expect(summary.message).toContain('Missing Permissions');
        expect(summary.message).toContain('again');
    });

    it('names unresolved keys individually so the operator can act on them', () => {
        const summary = summariseInstallOutcome(
            result({ unresolved: ['staff-role', 'archive'] })
        );

        expect(summary.message).toContain('staff-role');
        expect(summary.message).toContain('archive');
        expect(summary.tone).toBe('orange');
    });

    it('mentions the write-back when it filled anything in', () => {
        const summary = summariseInstallOutcome(
            result({ writtenCount: 3, updatedFlowIds: ['flow-1', 'flow-2'] })
        );

        expect(summary.message).toContain('3 settings');
        expect(summary.message).toContain('2 flows');
    });

    it('says so plainly when there was nothing to do', () => {
        const summary = summariseInstallOutcome(result({ applied: [] }));

        expect(summary.tone).toBe('brand');
        expect(summary.title).toBe('Nothing to do');
    });

    it('is unambiguously good news on a clean install', () => {
        const summary = summariseInstallOutcome(result());

        expect(summary.tone).toBe('brand');
        expect(summary.title).toBe('Installed');
    });

    it('does not call a failed write-back a success', () => {
        // The channels exist but nothing points at them. Zero settings written is
        // also what "nothing to write" looks like, so the flag is the only thing
        // separating a clean install from a broken flow.
        const summary = summariseInstallOutcome(result({ writeBackFailed: true }));

        expect(summary.tone).toBe('orange');
        expect(summary.title).not.toBe('Installed');
        expect(summary.message).toContain('created');
        expect(summary.message).toContain('again');
    });

    it('reports a failed write-back even when the apply itself was clean', () => {
        const summary = summariseInstallOutcome(
            result({ writeBackFailed: true, writtenCount: 0, failure: undefined })
        );

        expect(summary.title).toBe('Built, but not wired up');
    });
});

describe('summarising an install that threw', () => {
    it('promises nothing happened only for the statuses refused before applying', () => {
        // The route's own refusals plus the auth middleware's, all emitted before
        // anything is created — so the guild really is untouched.
        for (const status of [400, 401, 403, 404, 409]) {
            const summary = summariseInstallFailure(status, 'This flow declares nothing.');

            expect(summary.title).toBe('Nothing installed');
            expect(summary.message).toBe('This flow declares nothing.');
        }
    });

    it('does not claim a 500 installed nothing', () => {
        // A fault escaping mid-apply is a 500, and `ApiError` carries it exactly like
        // a refusal does — but channels and roles may already exist by then.
        const summary = summariseInstallFailure(500, 'Request failed (500)');

        expect(summary.title).not.toBe('Nothing installed');
        expect(summary.tone).toBe('orange');
    });

    it('does not claim a gateway timeout installed nothing', () => {
        // The apply makes many Discord calls; a proxy can give up while it runs on.
        const summary = summariseInstallFailure(504, 'Request failed (504)');

        expect(summary.title).not.toBe('Nothing installed');
        expect(summary.tone).toBe('orange');
    });

    it('tells the operator to look before re-running when the answer was lost', () => {
        // `fetch` itself threw — no status, no idea how far the apply got.
        const summary = summariseInstallFailure(null, "Couldn't install that.");

        expect(summary.tone).toBe('orange');
        expect(summary.title).toBe('Lost contact mid-install');
        expect(summary.message).toContain('Reopen');
        // Re-running is safe; the copy must say so or nobody will dare.
        expect(summary.message).toContain('reused');
    });
});
