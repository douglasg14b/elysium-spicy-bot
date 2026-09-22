/**
 * The orderings that made typing into a resource row impossible.
 *
 * Each block below is a sequence that actually happened in the browser, written as the
 * question the queue has to answer. The original code had no equivalent, which is why a
 * bug that made the feature unusable shipped with a green suite: the decisions lived in
 * a component, and `web/` has no jsdom.
 */

import { describe, expect, it } from 'vitest';
import type { ResourceDeclaration } from '../../api/types';
import {
    decideAutosaveAction,
    describeSaveFailure,
    isWorthSaving,
    RESOURCE_SAVE_DEBOUNCE_MS,
    shouldAcceptResponse,
} from '../resourceSaveQueue';

function channel(key: string, name = 'welcome'): ResourceDeclaration {
    return { key, kind: 'textChannel', defaultName: name };
}

describe('shouldAcceptResponse', () => {
    it('accepts a response nothing has superseded', () => {
        expect(shouldAcceptResponse(3, 3)).toBe(true);
    });

    /**
     * The revert, as the operator met it: type a character, the save it triggered comes
     * back carrying the list *without* the next characters, and applying it wipes them.
     */
    it('drops a response that a later edit has already superseded', () => {
        expect(shouldAcceptResponse(3, 4)).toBe(false);
    });

    it('drops a response superseded several times over', () => {
        expect(shouldAcceptResponse(1, 9)).toBe(false);
    });
});

describe('describeSaveFailure', () => {
    /**
     * A refusal of the list still on screen is worth showing and worth reverting to: the
     * operator is looking at exactly what the server rejected.
     */
    it('shows and reverts when the refused list is still the current one', () => {
        expect(describeSaveFailure(2, 2)).toEqual({ showError: true, revertToStored: true });
    });

    /**
     * **The destructive case.** Half a key is refused by `resourceSchema`; by the time
     * the refusal lands the operator has typed the rest. Re-reading the server here
     * overwrites a valid list with an older one — the revert — and the message describes
     * a problem that no longer exists.
     */
    it('neither shows nor reverts when editing continued during the request', () => {
        expect(describeSaveFailure(2, 5)).toEqual({ showError: false, revertToStored: false });
    });
});

describe('decideAutosaveAction', () => {
    const FLOW_A = 'guild-1/flow-a';
    const FLOW_B = 'guild-1/flow-b';

    it('adopts the stored list on first load, sending nothing', () => {
        expect(
            decideAutosaveAction({
                identity: FLOW_A,
                baselineIdentity: undefined,
                confirmed: undefined,
                current: '[]',
            })
        ).toBe('adoptBaseline');
    });

    it('waits when the list still matches what the server confirmed', () => {
        expect(
            decideAutosaveAction({
                identity: FLOW_A,
                baselineIdentity: FLOW_A,
                confirmed: '[1]',
                current: '[1]',
            })
        ).toBe('wait');
    });

    it('sends an edited list', () => {
        expect(
            decideAutosaveAction({
                identity: FLOW_A,
                baselineIdentity: FLOW_A,
                confirmed: '[1]',
                current: '[2]',
            })
        ).toBe('send');
    });

    /**
     * **The swallowed edit.** A refused save clears `confirmed` so the next edit is sent
     * regardless. While that cleared marker also meant "nothing loaded yet", this
     * returned `adoptBaseline` — the edit was silently recorded as the new baseline and
     * never sent, and since no request was issued the counter never advanced either, so
     * the re-read that followed could overwrite it. Keying the load test on the flow
     * rather than on this marker is what separates the two meanings.
     */
    it('sends after a refused save rather than treating the clear as a fresh load', () => {
        expect(
            decideAutosaveAction({
                identity: FLOW_A,
                baselineIdentity: FLOW_A,
                confirmed: undefined,
                current: '[2]',
            })
        ).toBe('send');
    });

    it('still sends after a refusal when the edit reproduces the refused list', () => {
        expect(
            decideAutosaveAction({
                identity: FLOW_A,
                baselineIdentity: FLOW_A,
                confirmed: undefined,
                current: '[1]',
            })
        ).toBe('send');
    });

    /**
     * `/flows/:flowId` is one route with no `key`, so switching flows re-renders rather
     * than remounts and the refs survive. Without the identity check, flow B's freshly
     * loaded list would be compared against flow A's baseline, differ, and be "saved" —
     * one flow's declarations written over another's.
     */
    it('adopts rather than sends when the flow changed under the same refs', () => {
        expect(
            decideAutosaveAction({
                identity: FLOW_B,
                baselineIdentity: FLOW_A,
                confirmed: '[1]',
                current: '[2]',
            })
        ).toBe('adoptBaseline');
    });

    it('adopts a new flow even when its list happens to match the old one', () => {
        expect(
            decideAutosaveAction({
                identity: FLOW_B,
                baselineIdentity: FLOW_A,
                confirmed: '[1]',
                current: '[1]',
            })
        ).toBe('adoptBaseline');
    });

    /**
     * The same hazard one axis over, reached by **attaching** rather than navigating.
     *
     * A flow's declarations belong to the journey it is attached to, and attaching moves
     * it to a different journey *without the flow id changing*. The panel then reloads
     * the new journey's list, which differs from the old journey's confirmed one — so
     * without the journey in the identity this returns `send`, and the newly loaded list
     * is written straight back into the journey just attached to.
     *
     * On a **shared** journey that write is refused with a 409, which the operator meets
     * as an error banner immediately after a successful attach. On an unshared one it
     * succeeds silently, which is worse: a write nobody asked for, against declarations
     * another flow may have authored.
     */
    it('adopts rather than sends when the flow was attached to another journey', () => {
        expect(
            decideAutosaveAction({
                identity: 'guild-1/flow-a/onboarding',
                baselineIdentity: 'guild-1/flow-a/rules',
                confirmed: '[1]',
                current: '[2]',
            })
        ).toBe('adoptBaseline');
    });

    it('still sends an ordinary edit while the journey is unchanged', () => {
        // The guard above must not swallow real edits: same flow, same journey, changed
        // list is the everyday case and has to reach the server.
        expect(
            decideAutosaveAction({
                identity: 'guild-1/flow-a/onboarding',
                baselineIdentity: 'guild-1/flow-a/onboarding',
                confirmed: '[1]',
                current: '[2]',
            })
        ).toBe('send');
    });

    it('tells a flow attached to nothing apart from one on a journey', () => {
        // The unattached case contributes an empty segment rather than being omitted, so
        // `guild/flow/` and `guild/flow/onboarding` are distinguishable — otherwise a
        // detach would look like no change at all.
        expect(
            decideAutosaveAction({
                identity: 'guild-1/flow-a/',
                baselineIdentity: 'guild-1/flow-a/onboarding',
                confirmed: '[1]',
                current: '[]',
            })
        ).toBe('adoptBaseline');
    });
});

describe('isWorthSaving', () => {
    it('sends an ordinary list', () => {
        expect(isWorthSaving([channel('welcome'), channel('rules', 'rules')])).toBe(true);
    });

    /** Select-all + Delete on a key, before retyping it. */
    it('holds while a key is empty mid-edit', () => {
        expect(isWorthSaving([channel('')])).toBe(false);
    });

    it('holds while a name is empty mid-edit', () => {
        expect(isWorthSaving([channel('welcome', '')])).toBe(false);
    });

    it('holds when any one row of many is mid-edit', () => {
        expect(isWorthSaving([channel('welcome'), channel('')])).toBe(false);
    });

    it('sends an empty list, which is how the last resource is removed', () => {
        expect(isWorthSaving([])).toBe(true);
    });

    /**
     * A partially typed key is a perfectly good key — `my-chann` on the way to
     * `my-channel` satisfies the slug pattern. Holding on those would mean the list was
     * only ever saved on the rare keystroke, which is the opposite of the intent.
     */
    it('sends a key that is merely unfinished rather than empty', () => {
        expect(isWorthSaving([channel('my-chann')])).toBe(true);
    });

    /**
     * Duplicates are deliberately *not* held back. They survive past the keystroke that
     * caused them, so declining to save would leave the operator with a list that never
     * persists and nothing saying why. The red chip explains it, and the server's refusal
     * is the honest answer.
     */
    it('sends a list holding a duplicate key, leaving the server to refuse it', () => {
        expect(isWorthSaving([channel('welcome'), channel('welcome', 'other')])).toBe(true);
    });
});

describe('RESOURCE_SAVE_DEBOUNCE_MS', () => {
    /**
     * Guards the two ends rather than the value: short enough that a list is durable
     * before the hand leaves the keyboard, long enough that ordinary typing coalesces
     * into one write instead of one per character.
     */
    it('is a pause a typist would not cross mid-word', () => {
        expect(RESOURCE_SAVE_DEBOUNCE_MS).toBeGreaterThanOrEqual(300);
        expect(RESOURCE_SAVE_DEBOUNCE_MS).toBeLessThanOrEqual(1500);
    });
});
