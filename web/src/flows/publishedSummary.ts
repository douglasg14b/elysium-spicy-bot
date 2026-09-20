/**
 * What the delete dialog says about what a flow has live in the guild.
 *
 * A pure module because `web/` has no jsdom and no React testing library — the repo's
 * established answer, visible in `cardSummary.ts` and `validationIssues.ts` beside it,
 * is to put the decisions here and test them, leaving the component to render what
 * this returns.
 *
 * ## Voice
 *
 * The product is sharp and this copy stays sharp. But a confirmation for an
 * irreversible destructive action has one job before it has a voice: the operator must
 * know exactly what is about to be destroyed. So the counts and the names are plain
 * and the sass sits around them, never in place of them. "Clarity first, sass second"
 * is the rule, and both are achievable — "Three channels and a role, gone for good" is
 * unambiguous *and* has a pulse.
 */

import type { PublishedFlowState, PublishedResource } from '../api/types';

/** What a delete dialog needs to say, decided here rather than in JSX. */
export interface PublishedSummary {
    /** True when there is anything at all to warn about. */
    readonly hasAnything: boolean;
    /** One line naming what a delete would leave behind, or null when nothing would. */
    readonly leftBehind: string | null;
    /** Whether to offer the "delete the buttons too" action. */
    readonly canUndeploy: boolean;
    /** Whether to offer the "delete the channels and roles too" action. */
    readonly canUnpublish: boolean;
    /** What unpublish will refuse to touch, one line each. Never summarised away. */
    readonly refusals: readonly string[];
    /** The caveat about buttons posted before we started recording them. */
    readonly unrecordedWarning: string | null;
}

function plural(count: number, one: string, many: string): string {
    return `${count} ${count === 1 ? one : many}`;
}

/**
 * Describe a set of resources by kind, so the operator reads "2 channels and a role"
 * rather than "3 resources".
 *
 * Kinds come off the wire as strings rather than a union, because the server's
 * `ResourceKind` is provisioning's type and mirroring it here would be a second place
 * to update. An unrecognised kind falls back to its own name rather than being dropped
 * — a resource nobody can name is still a resource about to be deleted.
 */
function describeResources(resources: readonly PublishedResource[]): string {
    const byKind = new Map<string, number>();
    for (const resource of resources) {
        byKind.set(resource.kind, (byKind.get(resource.kind) ?? 0) + 1);
    }

    const parts: string[] = [];
    for (const [kind, count] of byKind) {
        switch (kind) {
            case 'textChannel':
                parts.push(plural(count, 'channel', 'channels'));
                break;
            case 'category':
                parts.push(plural(count, 'category', 'categories'));
                break;
            case 'role':
                parts.push(plural(count, 'role', 'roles'));
                break;
            default:
                parts.push(plural(count, kind, `${kind}s`));
        }
    }

    return joinWithAnd(parts);
}

function joinWithAnd(parts: readonly string[]): string {
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0];
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Turn the server's answer into the lines a dialog shows.
 *
 * The refusals are returned individually and are never folded into a count. They are
 * the whole reason the preview exists: "1 item cannot be removed" tells an operator
 * nothing they can act on, while "**announcements** was adopted, not created" tells
 * them precisely why their channel is safe.
 */
export function summarisePublished(state: PublishedFlowState): PublishedSummary {
    const buttonCount = state.buttonMessages.length;
    const deletable = state.deletableResources;

    const parts: string[] = [];
    if (buttonCount > 0) {
        parts.push(`${plural(buttonCount, 'button message', 'button messages')} still posted`);
    }
    if (deletable.length > 0) {
        parts.push(`${describeResources(deletable)} it created`);
    }

    const refusals = state.refusedResources.map(
        (resource) => resource.explanation ?? `**${resource.name}** will be left alone.`
    );

    return {
        hasAnything: buttonCount > 0 || deletable.length > 0 || state.refusedResources.length > 0,
        leftBehind: parts.length > 0 ? joinWithAnd(parts) : null,
        canUndeploy: buttonCount > 0,
        canUnpublish: deletable.length > 0,
        refusals,
        unrecordedWarning: state.mayHaveUnrecordedButtons
            ? 'Buttons posted before this server started keeping track are not listed here, and cannot be cleaned up automatically. If you deployed this flow a while ago, go and delete the message yourself.'
            : null,
    };
}

/**
 * The sentence above the confirm button for an irreversible teardown.
 *
 * Deliberately names counts rather than gesturing at "everything": an operator
 * confirming the destruction of real channels is entitled to know how many, and a
 * dialog that says "this cannot be undone" without saying what *this* is has failed
 * at the only job it has.
 */
export function unpublishConfirmLine(resources: readonly PublishedResource[]): string {
    if (resources.length === 0) {
        return 'There is nothing to delete in the server.';
    }

    return `${describeResources(resources)} will be deleted from the server for good. Discord does not have a recycle bin, and neither do we.`;
}
