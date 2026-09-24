import { describe, expect, it } from 'vitest';
import type { ResourceBindingEntity } from '../../data/resourceBindingsSchema';
import { planJourneyMerge } from '../journeyMergePlan';
import type { ResourceDeclaration } from '../resourceDeclaration';

/**
 * The decision that stands between a drag and an orphaned channel.
 *
 * Two things are being pinned here, and they fail in opposite directions:
 *
 *  - **`canMerge`** must be false whenever a key is claimed on both sides, because
 *    merging a collision writes one key that names two channels and the installer
 *    resolves it by whichever it saw first.
 *  - **`orphaned`** must list exactly what is live, because the dialog's loud half is
 *    built from it. Over-report and every routine move reads as destructive; under-report
 *    and a real channel is abandoned with nothing said.
 */

function declaration(
    key: string,
    defaultName: string,
    kind: ResourceDeclaration['kind'] = 'textChannel'
): ResourceDeclaration {
    return { key, kind, defaultName };
}

function binding(
    resourceKey: string,
    state: ResourceBindingEntity['state'],
    discordId: string | null,
    name = resourceKey
): ResourceBindingEntity {
    return {
        id: 1,
        guildId: 'g1',
        journeyKey: 'source',
        resourceKey,
        kind: 'textChannel',
        state,
        discordId,
        name,
        createdAt: new Date(),
        updatedAt: new Date(),
    };
}

describe('planJourneyMerge', () => {
    it('allows a merge when the two declaration sets share no keys', () => {
        const plan = planJourneyMerge({
            movingDeclarations: [declaration('ticket-log', '#ticket-log')],
            destinationDeclarations: [declaration('welcome-channel', '#welcome')],
            movingBindings: [],
        });

        expect(plan.canMerge).toBe(true);
        expect(plan.collisions).toEqual([]);
    });

    it('refuses a merge when a key is claimed on both sides, naming what each means by it', () => {
        const plan = planJourneyMerge({
            movingDeclarations: [declaration('welcome-channel', '#tickets-welcome')],
            destinationDeclarations: [declaration('welcome-channel', '#welcome')],
            movingBindings: [],
        });

        expect(plan.canMerge).toBe(false);
        expect(plan.collisions).toEqual([
            {
                key: 'welcome-channel',
                movingName: '#tickets-welcome',
                destinationName: '#welcome',
            },
        ]);
    });

    it('reports every colliding key, not just the first', () => {
        const plan = planJourneyMerge({
            movingDeclarations: [
                declaration('welcome-channel', '#tickets-welcome'),
                declaration('verified', 'Ticket verified', 'role'),
                declaration('ticket-log', '#ticket-log'),
            ],
            destinationDeclarations: [
                declaration('welcome-channel', '#welcome'),
                declaration('verified', 'Verified', 'role'),
            ],
            movingBindings: [],
        });

        expect(plan.collisions.map((collision) => collision.key)).toEqual([
            'welcome-channel',
            'verified',
        ]);
    });

    it('counts a created binding as live, so leaving it behind is an orphan', () => {
        const plan = planJourneyMerge({
            movingDeclarations: [declaration('ticket-log', '#ticket-log')],
            destinationDeclarations: [],
            movingBindings: [binding('ticket-log', 'created', '555', '#ticket-log')],
        });

        expect(plan.orphaned).toEqual([
            {
                key: 'ticket-log',
                kind: 'textChannel',
                declaredName: '#ticket-log',
                live: { discordId: '555', name: '#ticket-log' },
            },
        ]);
    });

    it('counts an adopted binding as live too — provenance does not change that it exists', () => {
        const plan = planJourneyMerge({
            movingDeclarations: [declaration('ticket-log', '#ticket-log')],
            destinationDeclarations: [],
            movingBindings: [binding('ticket-log', 'adopted', '777')],
        });

        expect(plan.orphaned).toHaveLength(1);
        expect(plan.orphaned[0]?.live?.discordId).toBe('777');
    });

    /**
     * The case that decides whether the dialog cries wolf. An `intended` row is written
     * *before* the guild is touched, so it records a channel that was never created —
     * there is nothing in Discord to abandon.
     */
    it('does not treat an intended binding as live — nothing was ever created', () => {
        const plan = planJourneyMerge({
            movingDeclarations: [declaration('ticket-log', '#ticket-log')],
            destinationDeclarations: [],
            movingBindings: [binding('ticket-log', 'intended', null)],
        });

        expect(plan.orphaned).toEqual([]);
        expect(plan.moving[0]?.live).toBeNull();
    });

    /**
     * The same rule where it can actually fail. An `intended` row normally has a null id,
     * so a test using one passes with or without the state check — it was a green
     * assertion that could not go red. The state a crash leaves behind is the real
     * subject: the row was written, the channel may have been created, and the reconciler
     * owns deciding which. Treating that as live here would put a channel in the orphan
     * warning that `previewUnpublish` cannot confirm exists.
     */
    it('does not treat an intended binding with an id as live either', () => {
        const plan = planJourneyMerge({
            movingDeclarations: [declaration('ticket-log', '#ticket-log')],
            destinationDeclarations: [],
            movingBindings: [binding('ticket-log', 'intended', '444', '#ticket-log')],
        });

        expect(plan.orphaned).toEqual([]);
        expect(plan.moving[0]?.live).toBeNull();
    });

    it('does not treat a declaration with no binding at all as live', () => {
        const plan = planJourneyMerge({
            movingDeclarations: [declaration('never-installed', '#nope')],
            destinationDeclarations: [],
            movingBindings: [],
        });

        expect(plan.orphaned).toEqual([]);
    });

    it('separates the live from the merely declared within one move', () => {
        const plan = planJourneyMerge({
            movingDeclarations: [
                declaration('ticket-area', 'Tickets', 'category'),
                declaration('ticket-log', '#ticket-log'),
                declaration('ticket-staff', 'Ticket staff', 'role'),
            ],
            destinationDeclarations: [],
            movingBindings: [
                binding('ticket-area', 'created', '111', 'Tickets'),
                binding('ticket-log', 'created', '222', '#ticket-log'),
            ],
        });

        expect(plan.moving).toHaveLength(3);
        expect(plan.orphaned.map((resource) => resource.key)).toEqual([
            'ticket-area',
            'ticket-log',
        ]);
    });

    /**
     * A collision and a live binding are independent: the merge is refused because of the
     * key clash, and the orphan warning still has to name the channel that clash strands.
     */
    it('reports collisions and orphans together when both apply', () => {
        const plan = planJourneyMerge({
            movingDeclarations: [declaration('welcome-channel', '#tickets-welcome')],
            destinationDeclarations: [declaration('welcome-channel', '#welcome')],
            movingBindings: [binding('welcome-channel', 'created', '999', '#tickets-welcome')],
        });

        expect(plan.canMerge).toBe(false);
        expect(plan.orphaned).toHaveLength(1);
        expect(plan.orphaned[0]?.live?.name).toBe('#tickets-welcome');
    });

    it('is a silent move when the flow declares nothing', () => {
        const plan = planJourneyMerge({
            movingDeclarations: [],
            destinationDeclarations: [declaration('welcome-channel', '#welcome')],
            movingBindings: [],
        });

        expect(plan.moving).toEqual([]);
        expect(plan.orphaned).toEqual([]);
        expect(plan.canMerge).toBe(true);
    });
});
