/**
 * Whether renaming a resource should carry its key along, and what the key becomes.
 *
 * ## The bug
 *
 * `declarationForNewResource` slugified the key from the name **once**, at creation.
 * Press "＋ Channel" and you get `new-channel` / `#new-channel`; type "Welcome" over the
 * seeded name and the key stays `new-channel` forever. Nothing said so — the key field is
 * collapsed by default, so the operator's first sight of the stale key is usually in an
 * install plan, a permission rule, or a node picker labelled with a name nobody chose.
 *
 * The seeded name is the whole reason this bites. A row is created *already valid* (see
 * `addResource`), which means the operator's very first action on almost every resource
 * is to replace a generated name — and the key was derived from the generated one.
 *
 * ## The rule, and why it stops where it does
 *
 * **The key tracks the name until it is either hand-edited or installed, whichever comes
 * first.** Both halves are the same idea from different directions: the key stops being a
 * derived convenience the moment something else starts depending on it.
 *
 * - **Hand-edited** is detected structurally rather than by remembering an event: the key
 *   follows only while it is still one this panel derived — the slug of the name it
 *   currently has, or that slug with a de-duplication suffix. Type your own key and it no
 *   longer matches, so the next rename leaves it alone — permanently, without the panel
 *   having to carry an `edited` flag per row through patches, filters, removals and index
 *   shifts. `keyIsStillDerived` holds that test, and `setAdoption` asks the same question,
 *   so the two agree by construction rather than by both happening to be written the same
 *   way.
 *
 * - **Installed** freezes it outright. Once a binding exists the key is identity, not a
 *   label: `resource_bindings` rows key on it, and node configs hold `<field>Key` sidecars
 *   naming it (`resourceKeyFieldFor` in `controls/types.ts`). Changing it post-install
 *   orphans both — the binding is no longer found, so a reinstall creates a *second*
 *   channel, and `pendingResourceFields` refuses the graph save because the sidecar names a
 *   key nothing declares. So the freeze is not conservatism; unfreezing it corrupts.
 *
 * ## Why installed-ness is passed in rather than looked up
 *
 * This module is pure and the panel is handed a list of declarations, not a guild. The
 * caller supplies the keys that have bindings — `ResourcesDialog` gets them from the
 * published state it already fetches for the group header's install chip. A caller that
 * genuinely cannot know passes nothing, and then only the hand-edit half applies. That is
 * the documented narrow mode from the task, and it is safe rather than merely acceptable:
 * an operator who has installed a resource and then renames it is overwhelmingly likely to
 * have *seen* the key by then, but more to the point, the panel's live-state caller is the
 * one that can actually reach an installed resource, and it always passes the set.
 */

import type { ResourceDeclaration } from '../api/types';
import { slugifyResourceName, uniqueResourceKey } from './resourceAdoption';

/**
 * Whether a key is still one *we* derived, rather than one the operator wrote.
 *
 * The test is "does it equal the slug of the name it currently has" — **or that slug with a
 * de-duplication suffix**, which is the part that took a bug to find. `uniqueResourceKey`
 * hands back `welcome-2` when `welcome` is taken, and a naive equality test then reads its
 * own output as a hand edit on the very next keystroke: the row stops following its name
 * permanently, silently, and lands back in exactly the stale-key state this module exists
 * to prevent.
 *
 * That is not an edge case. `declarationForNewResource` seeds every new row from one of
 * three name constants, so adding a second channel produces `new-channel-2` before the
 * operator has typed anything at all — the collision is the *normal* first state of the
 * second row of its kind.
 *
 * One predicate rather than an inline comparison because two callers depend on it agreeing
 * with itself: this module's follow rule, and `setAdoption` in `ResourcesPanel`, which asks
 * the same "is this still the generated one?" question before re-seeding a key from an
 * adopted channel. Answering it two ways is how they would drift.
 */
export function keyIsStillDerived(resource: ResourceDeclaration): boolean {
    return keyIsDerivedFrom(resource.key, resource.defaultName);
}

/**
 * Whether `key` is the slug of `name`, allowing `uniqueResourceKey`'s `-N` suffix.
 *
 * The suffix is matched rather than stripped-and-compared so a *name* genuinely ending in a
 * number keeps working: `Room 2` slugs to `room-2`, and a key of `room-2` is then the exact
 * slug and matches on the first branch without the suffix rule ever being consulted.
 */
function keyIsDerivedFrom(key: string, name: string): boolean {
    const slug = slugifyResourceName(name);
    // An empty slug derives nothing — a name of only punctuation would otherwise make every
    // key look "derived from" it, since the suffix test below would match `resource-2`.
    if (!slug) return false;
    if (key === slug) return true;

    // `<slug>-<digits>`, which is the only other shape `uniqueResourceKey` produces.
    return new RegExp(`^${escapeForRegExp(slug)}-\\d+$`).test(key);
}

/** Escape a slug for literal use in a pattern. Slugs are `[a-z0-9-]`, but this is cheap. */
function escapeForRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface KeyFollowInput {
    /** The resource as it stands *before* the rename. */
    readonly resource: ResourceDeclaration;
    /** The name the operator has just typed. */
    readonly nextName: string;
    /**
     * Every declaration currently in the list, including the one being renamed.
     *
     * Needed whole rather than as "the others": the new key must be de-duplicated against
     * the rest of the list, and excluding the target is this module's job rather than the
     * caller's — a caller that filtered wrongly would silently produce a duplicate key,
     * which is the one outcome that must not be reachable by mistake.
     */
    readonly resources: readonly ResourceDeclaration[];
    /**
     * Resource keys that already have something live in the guild.
     *
     * Omitted by a caller with no way to know, which narrows the rule to hand-editing
     * alone — see the module header for why that degrades safely.
     */
    readonly installedKeys?: ReadonlySet<string>;
}

/**
 * The key a rename should produce, or `undefined` to leave the key alone.
 *
 * `undefined` rather than "the current key" so the caller can omit `key` from its patch
 * entirely: `applyResourcePatch` treats a key in the patch as a **rename** and runs the
 * reference rewrite, and a rename to the value it already holds would rebuild the array
 * and remount every row on each keystroke of the name field.
 */
export function keyForRenamedResource(input: KeyFollowInput): string | undefined {
    const { resource, nextName, resources, installedKeys } = input;

    // Identity, not a label, the moment anything in the guild points at it.
    if (installedKeys?.has(resource.key)) return undefined;

    // Still a generated key means nobody has claimed it. Asked against the *current* name
    // rather than any stored original, so a row renamed twice without touching the key
    // keeps following on the third — and `-N` suffixed keys still count as ours.
    if (!keyIsStillDerived(resource)) return undefined;

    const desired = slugifyResourceName(nextName);

    // Mid-word the name can slug to nothing — "Welcome!" typed as "!" on the way to it, or
    // a name cleared with select-all. `uniqueResourceKey` would substitute `resource`,
    // which is a real key the operator did not choose and which stops following the moment
    // it is written (it no longer matches the name's slug). Holding the previous key
    // instead keeps the row where it was until the name means something again.
    if (!desired) return undefined;
    if (desired === resource.key) return undefined;

    // De-duplicated against every *other* declaration. Without this, renaming one channel
    // to match another's name silently produces the duplicate key the server refuses and
    // the red `duplicateKey` chip complains about — caused by the panel rather than by the
    // operator, which is the one way this feature could be worse than the stale key it
    // replaces.
    const others = resources.filter((candidate) => candidate !== resource);
    return uniqueResourceKey(desired, others);
}
