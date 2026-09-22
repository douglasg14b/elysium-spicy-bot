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
 * Whether deleting this journey will be refused, and why.
 *
 * The server is the authority — `DELETE /journeys/:key` refuses while anything is
 * attached and names every flow — and this does **not** duplicate that rule to
 * pre-empt it. It exists so the page can disable the affordance and say what would have
 * to happen first, rather than offering a button whose only outcome is a red banner.
 *
 * The refusal copy itself is never composed here. When a delete is attempted anyway the
 * server's message is shown verbatim, because it is the one that names the flows and it
 * is the one that is actually true at the moment of the attempt.
 */
export function deleteBlockedReason(journey: JourneySummary): string | undefined {
    const attached = journey.attachedFlows;
    if (attached.length === 0) return undefined;

    return attached.length === 1
        ? `**${attached[0].name}** is still attached. Detach it first.`
        : `${attached.length} flows are still attached: ${attached
              .map((flow) => `**${flow.name}**`)
              .join(', ')}. Detach them first.`;
}

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
