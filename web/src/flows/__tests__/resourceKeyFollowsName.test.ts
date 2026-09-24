import { describe, expect, it } from 'vitest';
import type { ResourceDeclaration } from '../../api/types';
import { keyForRenamedResource, keyIsStillDerived } from '../resourceKeyFollowsName';

function channel(key: string, defaultName: string): ResourceDeclaration {
    return { key, kind: 'textChannel', defaultName };
}

describe('keyIsStillDerived', () => {
    // Shared with `setAdoption`, which asks the same question before re-seeding a key from
    // an adopted channel. The two agreeing is what stops adoption and renaming disagreeing
    // about which keys belong to the operator.

    it('accepts the exact slug of the name', () => {
        expect(keyIsStillDerived(channel('welcome', 'Welcome'))).toBe(true);
    });

    it('accepts a de-duplication suffix', () => {
        expect(keyIsStillDerived(channel('welcome-2', 'Welcome'))).toBe(true);
        expect(keyIsStillDerived(channel('new-channel-11', 'new-channel'))).toBe(true);
    });

    it('rejects a key the operator wrote', () => {
        expect(keyIsStillDerived(channel('lobby', 'Welcome'))).toBe(false);
    });

    it('rejects a suffix-shaped key belonging to a different name', () => {
        // `welcome-2` is derived from `Welcome`, not from `Rules` — the suffix rule must
        // not degrade into "any key ending in a number is ours".
        expect(keyIsStillDerived(channel('welcome-2', 'Rules'))).toBe(false);
    });

    it('rejects everything when the name slugs to nothing', () => {
        // Otherwise the suffix test would match `resource-2` and call an arbitrary key
        // derived from a name that derives nothing.
        expect(keyIsStillDerived(channel('resource-2', '!!!'))).toBe(false);
        expect(keyIsStillDerived(channel('welcome', ''))).toBe(false);
    });
});

describe('keyForRenamedResource', () => {
    it('follows the name while the key is still the generated one', () => {
        // The reported bug, verbatim: add a channel, rename it, watch the key rot.
        const resource = channel('new-channel', 'new-channel');

        expect(
            keyForRenamedResource({
                resource,
                nextName: 'Welcome',
                resources: [resource],
            })
        ).toBe('welcome');
    });

    it('keeps following after an earlier rename carried the key', () => {
        // The key matches the *current* name's slug rather than any remembered original,
        // so a second and third rename still follow.
        const resource = channel('welcome', 'Welcome');

        expect(
            keyForRenamedResource({
                resource,
                nextName: 'Front door',
                resources: [resource],
            })
        ).toBe('front-door');
    });

    it('leaves a hand-edited key alone', () => {
        // The key no longer equals the slug of its name, which is how "someone claimed
        // this" is detected without the panel carrying a per-row edited flag.
        const resource = channel('lobby', 'Welcome');

        expect(
            keyForRenamedResource({
                resource,
                nextName: 'Front door',
                resources: [resource],
            })
        ).toBeUndefined();
    });

    it('freezes the key once the resource is installed', () => {
        // A binding exists, so the key is identity: `resource_bindings` rows and node
        // config sidecars point at it and would be orphaned by a change.
        const resource = channel('welcome', 'Welcome');

        expect(
            keyForRenamedResource({
                resource,
                nextName: 'Front door',
                resources: [resource],
                installedKeys: new Set(['welcome']),
            })
        ).toBeUndefined();
    });

    it('still follows when some *other* resource is installed', () => {
        // The freeze is per resource, not per journey. A group where one channel is live
        // must not stop every sibling's key from tracking its name.
        const resource = channel('welcome', 'Welcome');
        const other = channel('rules', 'Rules');

        expect(
            keyForRenamedResource({
                resource,
                nextName: 'Front door',
                resources: [resource, other],
                installedKeys: new Set(['rules']),
            })
        ).toBe('front-door');
    });

    it('de-duplicates against the rest of the list', () => {
        // Renaming one channel onto another's name must not manufacture the duplicate key
        // the server refuses — the panel would be causing the error it then reports.
        const resource = channel('new-channel', 'new-channel');
        const taken = channel('welcome', 'Welcome');

        expect(
            keyForRenamedResource({
                resource,
                nextName: 'Welcome',
                resources: [taken, resource],
            })
        ).toBe('welcome-2');
    });

    it('does not count the renamed resource as its own collision', () => {
        // The target is excluded from the uniqueness check here rather than by the caller.
        // Were it included, every rename would suffix itself: `welcome` → `welcome-2`.
        const resource = channel('welcome', 'Welcome');

        expect(
            keyForRenamedResource({
                resource,
                nextName: 'Welcome',
                resources: [resource],
            })
        ).toBeUndefined();
    });

    it('holds the previous key while the name slugs to nothing', () => {
        // Mid-word states are ordinary: select-all then type, or a name that is briefly
        // only punctuation. Falling back to `uniqueResourceKey`'s `resource` placeholder
        // would write a key nobody chose *and* stop the follow, since that key no longer
        // matches the name.
        const resource = channel('welcome', 'Welcome');

        expect(
            keyForRenamedResource({
                resource,
                nextName: '!!!',
                resources: [resource],
            })
        ).toBeUndefined();

        expect(
            keyForRenamedResource({
                resource,
                nextName: '',
                resources: [resource],
            })
        ).toBeUndefined();
    });

    it('returns undefined when the derived key is unchanged', () => {
        // A patch carrying the key it already holds would be read as a rename by
        // `applyResourcePatch`, rebuilding the list and remounting rows per keystroke.
        const resource = channel('welcome', 'Welcome');

        expect(
            keyForRenamedResource({
                resource,
                // Slugs to `welcome` — a different name, the same key.
                nextName: 'WELCOME',
                resources: [resource],
            })
        ).toBeUndefined();
    });

    it('keeps following after a de-duplication suffix was applied', () => {
        // The trap: `uniqueResourceKey` hands back `welcome-2`, and a naive "key === slug
        // of name" test reads the panel's own output as a hand edit on the very next
        // keystroke — so the row silently stops following and lands back in exactly the
        // stale-key state this module exists to prevent.
        //
        // Not an edge case: `declarationForNewResource` seeds from three name constants,
        // so the second channel added is `new-channel-2` before anything is typed.
        const resource = channel('welcome-2', 'Welcome');
        const taken = channel('welcome', 'Welcome');

        expect(
            keyForRenamedResource({
                resource,
                nextName: 'Front door',
                resources: [taken, resource],
            })
        ).toBe('front-door');
    });

    it('treats a name that genuinely ends in a number as an exact match', () => {
        // `Room 2` slugs to `room-2`, so the key is the exact slug and the suffix rule is
        // never consulted. Renaming still follows.
        const resource = channel('room-2', 'Room 2');

        expect(
            keyForRenamedResource({ resource, nextName: 'Room 3', resources: [resource] })
        ).toBe('room-3');
    });

    it('follows for roles and categories too', () => {
        // Nothing in the rule is channel-specific, and a role's key is referenced by
        // permission rules exactly as a category's is by `parentKey`.
        const role: ResourceDeclaration = { key: 'new-role', kind: 'role', defaultName: 'new-role' };

        expect(
            keyForRenamedResource({ resource: role, nextName: 'Verified', resources: [role] })
        ).toBe('verified');
    });
});
