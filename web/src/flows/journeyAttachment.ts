/**
 * The decisions the journeys page and the builder's attach control both take, kept out
 * of the components so the suite can drive them.
 *
 * `web/` has no jsdom and no React Testing Library, so anything only reachable by
 * rendering is untestable here by construction. That is the reason this file exists
 * rather than a preference: the two rules below are the ones that are *wrong quietly* —
 * an attach described as an addition when it is a move, and a delete offered on a
 * journey the server is going to refuse — and neither would show up as a crash.
 */

import type { AttachedFlow, JourneySummary } from '../api/types';

/**
 * Turn a journey name into a key an operator can live with.
 *
 * Same shape as `slugifyResourceName` and for the same reason: the server's
 * `resourceKeySchema` accepts lowercase letters, digits and single hyphens, capped at 64
 * characters. Duplicating the transform rather than importing it keeps the two concepts
 * separate — a resource key is scoped inside a journey, a journey key is scoped to the
 * guild — and they are free to diverge if either constraint moves.
 */
export function slugifyJourneyName(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
}

/**
 * Make a journey key unique against the keys already in the guild.
 *
 * A duplicate key comes back from the server as a 409, which is a correct but late
 * answer to a question the create dialog can settle while it is being typed.
 */
export function uniqueJourneyKey(desired: string, existing: readonly string[]): string {
    // A name of only punctuation slugs to nothing, and the server's `min(1)` refuses an
    // empty key. Falling back keeps that failure out of the save path.
    const base = desired || 'journey';
    if (!existing.includes(base)) return base;

    let suffix = 2;
    while (existing.includes(`${base}-${suffix}`)) suffix += 1;
    return `${base}-${suffix}`;
}

/**
 * What to call the journey two flows create by being dragged together.
 *
 * It used to be the target flow's name verbatim, which produced a group header reading
 * **Flow E** directly above a row also reading *Flow E* — the header looked like a
 * duplicate of its own first member rather than the thing containing it, and nothing on
 * screen introduced the word "journey" at the one moment the concept first appears.
 *
 * **`"<target> journey"`, not `"Journey: <target>"`.** The header renders the name beside
 * a route glyph and above "2 flows · shared resources", so it is already framed as a
 * container; a `Journey:` prefix there reads as a field label repeating the frame, and it
 * sorts every journey under "J" in any list that orders by name. The suffix keeps the
 * operator's own word first — which is what they will scan for — and degrades into
 * ordinary English the moment they rename it, because it *is* ordinary English.
 *
 * The name is only a starting point: the header's rename is one click away, and the key
 * derived beside this is what anything installed actually points at. So this optimises for
 * being immediately legible rather than for being permanent.
 */
export function newJourneyNameFor(targetFlowName: string): string {
    const base = targetFlowName.trim();

    // A flow already called "... journey" would otherwise become "Onboarding journey
    // journey". Case-insensitive because the operator's capitalisation is theirs to keep.
    if (/\bjourney$/i.test(base)) return base;

    // The server caps journey names at 100 characters and refuses longer ones with a 400.
    // A flow name can reach that cap on its own, so the suffix has to be the part that
    // gives way — truncating the operator's name to make room for our word would be this
    // helper editing what they typed.
    const suffixed = `${base} journey`;
    return suffixed.length <= JOURNEY_NAME_MAX_LENGTH ? suffixed : base;
}

/**
 * The server's own cap, from `updateJourneyBody`/`createJourneyBody` in
 * `src/web/api/journeyRoutes.ts`. Mirrored rather than imported for the reason the whole
 * `web/api/types.ts` mirror exists: importing from `src/` drags the bot tree into the web
 * build.
 */
const JOURNEY_NAME_MAX_LENGTH = 100;

/*
 * `deleteBlockedReason` was here: it disabled the journeys page's delete button and said
 * which flows were holding the journey. Removed 2026-09-22 along with that page.
 *
 * Nothing replaced it because nothing deletes a journey any more. A journey now dies when
 * its last flow leaves, which is the same rule that governs its appearance run backwards
 * — so there is no affordance to pre-emptively disable, and no operator staring at a
 * button whose only outcome would be a refusal. `DELETE /journeys/:key` and its
 * name-every-flow refusal are untouched on the server.
 */

/**
 * What pressing "attach" is about to do, for the confirmation the operator reads.
 *
 * **A flow has at most one journey**, enforced by the unique index on
 * `(guildId, flowId)`, so attaching a flow that already has one *moves* it. Saying
 * "attach" flatly in that case would imply the flow ends up on two journeys and that
 * whatever it installs today is unaffected — neither is true, and the operator would
 * find out by watching their install plan change.
 *
 * `current` is the journey the flow is on now, as `GET /attachment` resolves it;
 * `undefined` for a flow attached to nothing.
 */
export function describeAttachIntent(input: {
    readonly currentJourneyName: string | undefined;
    readonly targetJourneyName: string;
}): string {
    if (!input.currentJourneyName) {
        return `This flow will install **${input.targetJourneyName}** — the channels and roles it declares.`;
    }

    return (
        `This flow is on **${input.currentJourneyName}**. A flow installs one journey, so ` +
        `this **moves** it to **${input.targetJourneyName}** — it will not be on both.`
    );
}

/**
 * What detaching leaves behind, said before it happens.
 *
 * Detach removes the association and **nothing else**: the journey stays, and so does
 * anything already installed in the guild, because those are real channels and roles and
 * removing them is `/unpublish`'s job. An operator who reads "detach" as "undo the
 * install" would go looking for channels that are still there.
 */
export function describeDetachIntent(input: {
    readonly journeyName: string;
    readonly sharedWith: readonly AttachedFlow[];
}): string {
    const base =
        `This flow will stop installing **${input.journeyName}**. The journey itself stays, ` +
        `and so does anything it has already put in your server — removing those is a separate step.`;

    if (input.sharedWith.length === 0) return base;

    const names = input.sharedWith.map((flow) => `**${flow.name}**`).join(', ');
    return `${base} ${
        input.sharedWith.length === 1 ? 'The flow' : 'These flows'
    } ${names} ${input.sharedWith.length === 1 ? 'is' : 'are'} still attached to it.`;
}

/**
 * The journeys a flow may be attached to, ordered for a picker.
 *
 * The journey the flow is already on is **excluded rather than disabled**: re-attaching
 * where it already is does nothing, and an option that is a no-op invites the operator to
 * wonder what it did.
 */
export function attachableJourneys(
    journeys: readonly JourneySummary[],
    currentJourneyKey: string | undefined
): JourneySummary[] {
    return journeys.filter((journey) => journey.journeyKey !== currentJourneyKey);
}
