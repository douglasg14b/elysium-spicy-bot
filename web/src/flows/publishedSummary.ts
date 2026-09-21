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
 *
 * Density is part of clarity here. Prose that restates what the list already shows is
 * not warmth, it is another paragraph between the operator and the answer — so the
 * dialog leads with the inventory and keeps the sentences around it to one line each.
 */

import type { PublishedFlowState, PublishedResource, ResourceKind } from '../api/types';
import { RESOURCE_KIND_STYLES } from './resourceMeta';

/**
 * One resource, as a row in the dialog's inventory.
 *
 * `fate` is the whole point of listing them: an operator looking at a teardown needs to
 * see, per resource, whether this one dies or survives. Folding the survivors into a
 * separate section below meant reading two lists and mentally diffing them, when the
 * question — "what happens to #tickets?" — is per row.
 */
export interface PublishedResourceLine {
    readonly resourceKey: string;
    /**
     * Which kind the row wears, for the icon and colour.
     *
     * A `ResourceKind` where the wire supplied one it recognises, so the row can be
     * drawn from `RESOURCE_KIND_STYLES` and inherit the same violet/blue/orange
     * vocabulary the resources panel uses. `message` is not a resource kind — button
     * messages are not provisioned — but it shares the row, so it shares the union.
     * `unknown` is the fallback for a kind this build has not heard of, which is still
     * a real thing about to be deleted and must not be dropped.
     */
    readonly glyph: ResourceKind | 'message' | 'unknown';
    /** `channel`, `category`, `role` — the noun, not the wire kind. */
    readonly kindLabel: string;
    /** What it is called in the server, with `#` or `@` already applied. */
    readonly displayName: string;
    readonly fate: 'deleted' | 'kept';
    /** Why it survives, or where it sits. Shown at the end of the row. */
    readonly explanation?: string;
}

/**
 * One titled block of rows in the dialog.
 *
 * Grouping by fate rather than listing everything flat is the point: it makes "what
 * dies" a region an operator can size at a glance, instead of a word they have to read
 * down a column and tally themselves.
 */
export interface PublishedGroup {
    readonly id: 'created' | 'blocked' | 'adopted' | 'messages';
    readonly title: string;
    /** The aside beside the title — what this group means for the teardown. */
    readonly caption: string;
    /** True when this group's rows are the ones an uninstall destroys. */
    readonly destructive: boolean;
    readonly lines: readonly PublishedResourceLine[];
}

/** What a delete dialog needs to say, decided here rather than in JSX. */
export interface PublishedSummary {
    /** True when there is anything at all to warn about. */
    readonly hasAnything: boolean;
    /** One line naming what a delete would leave behind, or null when nothing would. */
    readonly leftBehind: string | null;
    /**
     * The dialog's body, as titled groups. Empty groups are dropped rather than
     * rendered as a heading over nothing.
     *
     * Every resource is named individually rather than counted. "1 channel and 1
     * category" told an operator how *many* things a destructive button would take, but
     * not *which* — and the names were on the wire the whole time.
     */
    readonly groups: readonly PublishedGroup[];
    /** Whether to offer the "delete the buttons too" action. */
    readonly canUndeploy: boolean;
    /** Whether to offer the "delete the channels and roles too" action. */
    readonly canUnpublish: boolean;
    /** How many button messages are still posted. Zero when none are. */
    readonly buttonCount: number;
    /** How many resources an uninstall would actually delete. */
    readonly deletableCount: number;
    /**
     * The uninstall button's label, carrying its own count.
     *
     * On the button rather than in a confirmation card: the card restated what the list
     * above it already showed, so it was a paragraph between the operator and the
     * action. A button that names its count is the warning.
     */
    readonly unpublishLabel: string;
    /** The same button once armed, for the in-place second click. */
    readonly unpublishConfirmLabel: string;
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
        const noun = kindNoun(kind);
        // "categories", not "categorys". The only kind whose plural is not a bare `s`.
        parts.push(plural(count, noun, noun === 'category' ? 'categories' : `${noun}s`));
    }

    return joinWithAnd(parts);
}

function joinWithAnd(parts: readonly string[]): string {
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0];
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Whether the wire's kind is one this build draws, narrowing `string` to the union.
 *
 * The wire types `kind` as `string` deliberately — the server's `ResourceKind` is
 * provisioning's, and mirroring it would be a second place to update. So the narrowing
 * happens once, here, and everything downstream keys off `RESOURCE_KIND_STYLES`.
 */
function isKnownKind(kind: string): kind is ResourceKind {
    return kind in RESOURCE_KIND_STYLES;
}

/**
 * How a resource is written in a list.
 *
 * The prefix comes from `RESOURCE_KIND_STYLES` rather than a local rule, so a name
 * here reads exactly as it does in the resources panel and in the pickers — `#` on a
 * channel, `@` on a role, nothing on a category. An unrecognised kind is shown bare;
 * inventing punctuation for something we cannot identify would be a guess printed next
 * to a delete button.
 */
function displayName(resource: PublishedResource): string {
    if (!isKnownKind(resource.kind)) return resource.name;
    return `${RESOURCE_KIND_STYLES[resource.kind].prefix}${resource.name}`;
}

/** The noun for one resource of this kind, for a row that names a single thing. */
function kindNoun(kind: string): string {
    return isKnownKind(kind) ? RESOURCE_KIND_STYLES[kind].label.toLowerCase() : kind;
}

function toLine(resource: PublishedResource, fate: 'deleted' | 'kept'): PublishedResourceLine {
    return {
        resourceKey: resource.resourceKey,
        glyph: isKnownKind(resource.kind) ? resource.kind : 'unknown',
        kindLabel: kindNoun(resource.kind),
        displayName: displayName(resource),
        fate,
        explanation: fate === 'kept' ? resource.explanation : undefined,
    };
}

/**
 * Turn the server's answer into the lines a dialog shows.
 *
 * Every resource is listed by name, and the survivors keep their individual reason.
 * Both follow the same rule: a count is not something an operator can act on. "1 item
 * cannot be removed" tells them nothing, while "**announcements** — adopted, not
 * created" tells them precisely why their channel is safe. The same argument applies to
 * the deletions, which is why they are named too rather than summed into "1 channel".
 *
 * Deleted resources sort first. The destructive half of the dialog is what the operator
 * came to check, and burying it under the survivors would make them scroll past what is
 * safe to find what is not.
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

    /*
     * Refusals are split by *why*, because the reasons say opposite things about
     * ownership and a single heading has to lie about one of them.
     *
     * `adopted` was never this flow's — it found the channel and pointed at it.
     * Everything else *was* created by this flow and is being kept back for a reason
     * the operator can usually clear: a category someone has since added a channel to,
     * a missing permission, a role above the bot. Filing those under "Adopted, not
     * created" told the operator the flow did not make something it did make.
     */
    const adopted = state.refusedResources.filter(
        (resource) => resource.refusalReason === 'adopted'
    );
    const blocked = state.refusedResources.filter(
        (resource) => resource.refusalReason !== 'adopted'
    );

    /*
     * Built as a list and filtered, so an empty group is dropped rather than rendered
     * as a heading standing over nothing. A flow that adopted everything should not be
     * shown a "Created by this flow" title with no rows beneath it.
     */
    const groups: readonly PublishedGroup[] = ([
        {
            id: 'created',
            title: 'Created by this flow',
            caption: 'uninstalling deletes these',
            destructive: true,
            lines: deletable.map((resource) => toLine(resource, 'deleted')),
        },
        {
            id: 'blocked',
            title: 'Created, but kept for now',
            caption: 'something is in the way',
            destructive: false,
            lines: blocked.map((resource) => toLine(resource, 'kept')),
        },
        {
            id: 'adopted',
            title: 'Adopted, not created',
            caption: 'left untouched',
            destructive: false,
            lines: adopted.map((resource) => toLine(resource, 'kept')),
        },
        {
            id: 'messages',
            title: 'Posted messages',
            caption: 'taking these down leaves the channels',
            destructive: false,
            lines: state.buttonMessages.map((message) => ({
                resourceKey: `${message.channelId}:${message.messageId}`,
                glyph: 'message' as const,
                kindLabel: 'message',
                displayName: `${plural(message.nodeIds.length, 'button', 'buttons')} posted`,
                fate: 'kept' as const,
            })),
        },
    ] satisfies readonly PublishedGroup[]).filter((group) => group.lines.length > 0);

    const deletableCount = deletable.length;
    const countedThings = plural(deletableCount, 'resource', 'resources');

    return {
        hasAnything: groups.length > 0,
        leftBehind: parts.length > 0 ? joinWithAnd(parts) : null,
        groups,
        canUndeploy: buttonCount > 0,
        canUnpublish: deletableCount > 0,
        buttonCount,
        deletableCount,
        unpublishLabel: `Delete ${countedThings}`,
        unpublishConfirmLabel: `Yes, delete ${countedThings}`,
    };
}

/*
 * `unpublishConfirmLine` used to live here, supplying the sentence above a confirmation
 * card. The card is gone: it restated what the list directly above it already showed,
 * which made it a paragraph standing between the operator and the action rather than a
 * safeguard. The second click now happens on the button itself, which carries its own
 * count via `unpublishConfirmLabel`.
 */
