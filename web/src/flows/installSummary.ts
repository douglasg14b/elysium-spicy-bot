/**
 * What the install dialog says about a plan, and about what an install did.
 *
 * A pure module for the same reason `publishedSummary.ts` beside it is one: `web/` has
 * no jsdom and no React testing library, so a decision left inside JSX is a decision
 * nothing can check. The component renders what these return.
 *
 * ## Voice
 *
 * Sharp, but the operator is about to create real channels and roles in their server
 * and then read what happened. Counts and names stay plain; the sass sits around them.
 * Same rule as the teardown copy: clarity first, sass second.
 */

import type { InstallPlan, InstallPlanItem, InstallResult, ResourceKind } from '../api/types';

/** What the review step needs to say, decided here rather than in JSX. */
export interface InstallPlanSummary {
    /** One line naming what the apply will do, or null when it will do nothing. */
    readonly headline: string | null;
    /** Whether to offer the confirm at all. */
    readonly canApply: boolean;
    /**
     * Everything standing in the way, one line each — guild-level blockers first,
     * then per-item ones. Never summarised into a count: "2 problems" tells an
     * operator nothing, while the sentence naming the channel tells them what to fix.
     */
    readonly problems: readonly string[];
    /** Items the apply will act on. Empty when everything is already in place. */
    readonly changes: readonly InstallPlanItem[];
    /** Items already bound and resolving, which the apply will leave alone. */
    readonly unchanged: readonly InstallPlanItem[];
}

function plural(count: number, one: string, many: string): string {
    return `${count} ${count === 1 ? one : many}`;
}

function joinWithAnd(parts: readonly string[]): string {
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0];
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The nouns one kind is counted by. */
interface KindNouns {
    readonly one: string;
    readonly many: string;
}

/**
 * The noun for every kind, keyed so a new one cannot be added without supplying it.
 *
 * A `Record<ResourceKind, …>` rather than a switch: the union is closed, and the
 * compiler refusing an incomplete table is the only thing that stops a fourth kind
 * from reaching the dialog that precedes creating real guild objects.
 */
const KIND_NOUNS: Record<ResourceKind, KindNouns> = {
    textChannel: { one: 'channel', many: 'channels' },
    category: { one: 'category', many: 'categories' },
    role: { one: 'role', many: 'roles' },
};

/**
 * Nouns for a kind off the wire, which is `string` rather than `ResourceKind`.
 *
 * `ResourceKind` is a hand-written mirror with no drift test behind it, so a kind this
 * build has not heard of falls back to its own name instead of being dropped — a
 * resource nobody can name is still one about to be created. Callers holding the union
 * itself go through {@link kindLabel} and keep the compiler's check.
 */
function nounsFor(kind: string): KindNouns {
    return KIND_NOUNS[kind as ResourceKind] ?? { one: kind, many: `${kind}s` };
}

/**
 * What one item of this kind is called, for the line naming a single resource.
 *
 * Lives here rather than in the component for the reason the whole module does: a
 * two-way `kind === 'role' ? 'role' : 'channel'` inside JSX is a decision nothing can
 * test, and that exact shape is what called a category a channel. Rendering from the
 * declared `kind` rather than from the shape of the resource key is the rule; the
 * retired Discord apply button learned it the same way.
 */
export function kindLabel(kind: ResourceKind): string {
    return KIND_NOUNS[kind].one;
}

/**
 * Describe items by kind, so the operator reads "2 channels and a role" rather than
 * "3 resources".
 */
function describeItems(items: readonly InstallPlanItem[]): string {
    const byKind = new Map<string, number>();
    for (const item of items) {
        byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
    }

    const parts: string[] = [];
    for (const [kind, count] of byKind) {
        const nouns = nounsFor(kind);
        parts.push(plural(count, nouns.one, nouns.many));
    }

    return joinWithAnd(parts);
}

/**
 * Turn a plan into the lines the review step shows.
 *
 * `canApply` follows the server's `applicable` rather than re-deriving it from the
 * items: the server re-checks on apply regardless, and a browser with its own opinion
 * would eventually offer a button that 409s.
 */
export function summariseInstallPlan(plan: InstallPlan): InstallPlanSummary {
    const changes = plan.items.filter(
        (item) => item.action === 'create' || item.action === 'adopt'
    );
    const unchanged = plan.items.filter((item) => item.action === 'reuse');

    const problems = [
        ...plan.blockers,
        ...plan.items
            .filter((item) => item.action === 'blocked')
            .map((item) => item.reason ?? `**${item.name}** needs a decision before this can run.`),
    ];

    const creating = changes.filter((item) => item.action === 'create');
    const adopting = changes.filter((item) => item.action === 'adopt');

    const parts: string[] = [];
    if (creating.length > 0) parts.push(`create ${describeItems(creating)}`);
    if (adopting.length > 0) parts.push(`adopt ${describeItems(adopting)}`);

    return {
        headline: parts.length > 0 ? `This will ${joinWithAnd(parts)} in your server.` : null,
        canApply: plan.applicable && changes.length > 0,
        problems,
        changes,
        unchanged,
    };
}

/** How an install went, as a notification. */
export interface InstallOutcomeSummary {
    /** `orange` when it stopped partway or left something unresolved. */
    readonly tone: 'brand' | 'orange';
    readonly title: string;
    readonly message: string;
}

/**
 * Describe what an install actually did.
 *
 * A partial install is reported as a partial install, not as a failure. What was
 * created is real and bound, the ids are already written into the flows that picked
 * them, and re-running continues from there — so the copy says where it stopped and
 * what to do, rather than implying nothing happened.
 *
 * Unresolved keys are named individually for the same reason the teardown's refusals
 * are: a count is not something an operator can act on.
 */
export function summariseInstallOutcome(result: InstallResult): InstallOutcomeSummary {
    const created = result.applied.length;
    const wired =
        result.writtenCount > 0
            ? ` Wired ${plural(result.writtenCount, 'setting', 'settings')} into ${plural(
                  result.updatedFlowIds.length,
                  'flow',
                  'flows'
              )}.`
            : '';

    const stillWaiting =
        result.unresolved.length > 0
            ? ` Still waiting on ${result.unresolved.join(', ')} — flows picking those won't run properly yet.`
            : '';

    /*
     * Checked before `failure`, and reported even when the apply itself was clean.
     * The channels exist but nothing points at them, which looks like a success and
     * behaves like a broken flow — the one outcome an operator would otherwise not
     * learn about until the flow ran.
     */
    if (result.writeBackFailed) {
        return {
            tone: 'orange',
            title: 'Built, but not wired up',
            message:
                `${plural(created, 'thing', 'things')} created — but writing the ids into your ` +
                `blocks failed, so those flows won't run properly yet. Run install again to retry ` +
                `the wiring; it reuses what already exists.`,
        };
    }

    if (result.failure) {
        return {
            tone: 'orange',
            title: 'Stopped partway',
            message:
                `${plural(created, 'thing', 'things')} made it in before this: ${result.failure}` +
                `${wired}${stillWaiting} Run install again to pick up where it left off.`,
        };
    }

    if (created === 0) {
        return {
            tone: 'brand',
            title: 'Nothing to do',
            message: 'Everything this flow declares was already in place.',
        };
    }

    return {
        tone: result.unresolved.length > 0 ? 'orange' : 'brand',
        title: 'Installed',
        message: `${plural(created, 'thing', 'things')} set up in your server.${wired}${stillWaiting}`,
    };
}

/** How a failed install request is reported. Same triple the outcome uses. */
export interface InstallFailureSummary {
    readonly tone: 'red' | 'orange';
    readonly title: string;
    readonly message: string;
}

/**
 * The HTTP statuses the install endpoint refuses on **before** touching the guild.
 *
 * `POST /install` answers 404 for a flow that is not there and 409 for one whose
 * journey is refused or whose plan stopped being applicable; the auth middleware in
 * front of it answers 400/401/403 without the route running at all. Every one of them
 * is emitted ahead of any creation — including the `notApplicable` 409, which comes
 * out of `runInstall` before it installs anything — which is what makes "nothing was
 * touched" safe to say. A partial apply is a **200** carrying `failure`, so it never
 * reaches here.
 */
const REFUSED_BEFORE_APPLYING: readonly number[] = [400, 401, 403, 404, 409];

/**
 * Describe a thrown install, for the one question the operator actually has: is my
 * server untouched?
 *
 * Only the statuses above answer that with a yes. Anything else — a 500 from a fault
 * escaping mid-apply, a proxy 502/504 on a request that makes many Discord calls, or a
 * `fetch` that never came back at all — leaves the apply's progress unknown, and it may
 * have run to completion and written ids back with only the answer lost. Promising
 * those operators that nothing happened would send them into a retry believing their
 * server is clean, in a feature built on partial application being a legitimate state.
 *
 * Takes the status rather than the error so this stays free of the client module; the
 * component passes `err instanceof ApiError ? err.status : null`.
 */
export function summariseInstallFailure(
    status: number | null,
    message: string
): InstallFailureSummary {
    if (status !== null && REFUSED_BEFORE_APPLYING.includes(status)) {
        return { tone: 'red', title: 'Nothing installed', message };
    }

    return {
        tone: 'orange',
        title: 'Lost contact mid-install',
        message:
            "The request died on the way back, so nobody here knows how far it got — it may have " +
            "built everything, or nothing at all. Reopen this dialog to see what's actually in " +
            'your server before running it again; anything already there gets reused, not duplicated.',
    };
}
