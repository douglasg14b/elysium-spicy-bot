import type { ResourceBindingEntity } from '../data/resourceBindingsSchema';
import type { ResourceDeclaration, ResourceKind } from './resourceDeclaration';

/**
 * Whether a live guild object is still what its journey declared it to be.
 *
 * ## The third question
 *
 * Install asks *does this exist*; teardown asks *may I delete this*. Neither asks
 * whether the object still matches the declaration it came from, and today nothing
 * does — `buildInstallPlan` decides `reuse` on `cache.has(id)` alone, so a channel
 * renamed, dragged out of its category, and stripped of every overwrite still reports
 * as a clean reuse and install changes nothing.
 *
 * The permission case is why this is a defect rather than untidiness. A journey's
 * stated value is *"this channel is visible only to this role"*; a silent divergence
 * there makes a staff-only channel public while the install path keeps certifying it.
 * Detecting it is the difference between a provisioning system and a create-once
 * script.
 *
 * ## Why this module takes no `Guild`
 *
 * The caller reads Discord and hands the result in as a {@link LiveResourceSnapshot}.
 * That keeps every rule below — and the permission rules are genuinely subtle —
 * testable in four lines instead of behind a fake guild. `unpublishPlan.ts` takes a
 * `Guild` and is materially harder to exercise for exactly this reason.
 *
 * The cost is one extra type and one extra hop at the call site. It buys the ability
 * to state each rule as a test that reads like the rule.
 */

/**
 * One way a live object differs from its declaration.
 *
 * Each variant carries what it needs to *render* and to *repair*, rather than a flag
 * the repair path would have to re-derive from. A repair that recomputes its own
 * target can disagree with what the operator was shown and approved, which is the one
 * failure this shape exists to make impossible.
 */
export type ResourceDriftKind =
    | { readonly kind: 'renamed'; readonly declared: string; readonly actual: string }
    | {
          readonly kind: 'reparented';
          /** The binding id of the declared parent, or null when top-level is declared. */
          readonly declaredParentId: string | null;
          readonly actualParentId: string | null;
      }
    | { readonly kind: 'wrongType'; readonly declared: ResourceKind; readonly actual: string }
    | { readonly kind: 'permissions'; readonly differences: readonly PermissionDifference[] };

/** One id whose access no longer matches what the declaration compiled to. */
export interface PermissionDifference {
    /** The role or member id the overwrite is for. */
    readonly id: string;
    /** Permission bits the declaration allows that are not allowed live. */
    readonly missingAllow: readonly string[];
    /** Permission bits the declaration denies that are not denied live. */
    readonly missingDeny: readonly string[];
}

/**
 * What the guild currently holds for one binding.
 *
 * Assembled by the caller from `discord.js` caches. `type` is the raw channel-type
 * label rather than a {@link ResourceKind} precisely because the mismatch case is one
 * of the things being detected — narrowing it here would discard the evidence.
 */
export interface LiveResourceSnapshot {
    readonly name: string;
    /** The live object's kind, or a label for it when it is not a kind we declare. */
    readonly kind: ResourceKind | { readonly unrecognised: string };
    /** Channels only; null for a top-level channel and for every role. */
    readonly parentId: string | null;
    /** Channels only. Roles carry no overwrites. */
    readonly overwrites?: readonly LiveOverwrite[];
}

/** One permission overwrite as Discord reports it. */
export interface LiveOverwrite {
    readonly id: string;
    /** Allowed bits, as decimal strings — the form `PermissionsBitField` serialises to. */
    readonly allow: readonly string[];
    readonly deny: readonly string[];
}

/**
 * One compiled overwrite, in the shape this comparison consumes.
 *
 * Deliberately **not** `OverwriteResolvable`. That type is what `discord.js` accepts on
 * the way *in* — it permits a `Role`, a `GuildMember`, or a `PermissionResolvable`
 * union — and typing the input to it made this module claim to handle shapes it does
 * not compare and cannot repair.
 *
 * `compilePermissionIntents` in fact returns exactly this: a plain id with `bigint`
 * bit arrays. Naming that shape here means the comparison is typed against what it
 * actually receives, and a change to the compiler's output breaks at compile time
 * rather than producing a silently empty diff.
 */
export interface CompiledOverwrite {
    readonly id: string;
    readonly allow: readonly bigint[];
    readonly deny: readonly bigint[];
}

export interface ResourceDriftInput {
    readonly declaration: ResourceDeclaration;
    readonly binding: ResourceBindingEntity;
    readonly live: LiveResourceSnapshot;
    /**
     * The declaration's permission intents, already compiled.
     *
     * Compiled by the caller rather than here because `compilePermissionIntents` needs
     * a `Guild` to resolve an audience, and this module deliberately has none. Absent
     * means "not comparable" rather than "no permissions" — see
     * {@link ResourceDriftReport.skippedPermissions}.
     */
    readonly compiledOverwrites?: readonly CompiledOverwrite[];
    /**
     * The snowflake of the declared parent, resolved through its own binding.
     *
     * Resolved by the caller because it requires the *other* resource's binding, which
     * this comparison cannot see. `undefined` means the declaration names a parent
     * whose binding does not exist yet — not comparable, so not drift.
     */
    readonly declaredParentId?: string | null;
    /**
     * The bot's own id, excluded from permission comparison.
     *
     * `compilePermissionIntents` appends an overwrite for the bot unconditionally so it
     * can never be locked out of a channel it must repair. That overwrite is not an
     * authored intent, so reporting it as a difference would show the operator a
     * "drift" they never declared and cannot fix.
     */
    readonly botId?: string;
}

export interface ResourceDriftReport {
    readonly resourceKey: string;
    readonly name: string;
    readonly kind: ResourceKind;
    readonly discordId: string;
    readonly drift: readonly ResourceDriftKind[];
    /**
     * Set when permission drift could not be assessed, saying why.
     *
     * A stated skip rather than a silent clean result. A `subject` audience names a
     * per-run member and cannot be compiled while provisioning shared guild structure,
     * so the honest answer is "not checked, because" — reporting it as clean would be
     * the silent-fallback this repo's rules forbid, on the one property where a false
     * clean is a privacy failure.
     */
    readonly skippedPermissions?: string;
    /**
     * Whether repairing this resource is allowed without an explicit override.
     *
     * `false` for an adopted resource. Adoption is the promise that we will not touch
     * structure the operator says predates us, and `buildUnpublishPlan` already refuses
     * to delete on exactly this ground. A promise that holds for deletion but not for a
     * rename is not a promise — so drift is *detected* on an adopted resource, because
     * a staff-only channel going public matters regardless of who made it, and repair
     * is withheld.
     */
    readonly repairable: boolean;
}

const KIND_LABEL: Record<ResourceKind, string> = {
    category: 'category',
    textChannel: 'channel',
    role: 'role',
};

/**
 * Compare one live object against the declaration it was created from.
 *
 * Returns an empty `drift` array when everything matches, rather than `null`, so a
 * caller can report "checked, clean" distinctly from "not checked" — the distinction
 * {@link ResourceDriftReport.skippedPermissions} exists to preserve.
 */
export function detectResourceDrift(input: ResourceDriftInput): ResourceDriftReport {
    const { declaration, binding, live } = input;

    // Every caller has already established this; asserting it here keeps the report's
    // `discordId` non-nullable, which the repair path depends on.
    if (!binding.discordId) {
        throw new Error(
            `Resource "${declaration.key}" has no bound Discord id, so there is nothing to compare it against. An unbound resource is install's concern, not drift's.`
        );
    }

    const base = {
        resourceKey: declaration.key,
        name: binding.name,
        kind: declaration.kind,
        discordId: binding.discordId,
        // The adoption promise, read off provenance rather than re-derived.
        repairable: binding.state !== 'adopted',
    } as const;

    /*
     * A type mismatch suppresses every other comparison, and that is a deliberate
     * choice rather than an optimisation.
     *
     * If the id now resolves to a text channel where a category was declared, then
     * "the name differs" and "the overwrites differ" are both true and both useless —
     * they describe a comparison against an object that is not the resource at all.
     * Worse, the repair for each would be wrong: this is not a rename, it is a re-bind
     * or a recreate, and that is a decision only the operator can take.
     */
    const actualKind = liveKindLabel(live.kind);
    if (actualKind !== declaration.kind) {
        return {
            ...base,
            drift: [{ kind: 'wrongType', declared: declaration.kind, actual: actualKind }],
        };
    }

    const drift: ResourceDriftKind[] = [];

    if (live.name !== binding.name) {
        drift.push({ kind: 'renamed', declared: binding.name, actual: live.name });
    }

    const reparented = detectReparent(input);
    if (reparented) drift.push(reparented);

    const permissions = detectPermissionDrift(input);
    if (permissions.difference) drift.push(permissions.difference);

    return {
        ...base,
        drift,
        ...(permissions.skipped ? { skippedPermissions: permissions.skipped } : {}),
    };
}

/** The live kind as a comparable label, flattening the unrecognised case. */
function liveKindLabel(kind: LiveResourceSnapshot['kind']): string {
    return typeof kind === 'string' ? kind : kind.unrecognised;
}

/**
 * Whether the object has been moved out of the category its journey declared.
 *
 * **Compared by id, never by name.** A category that has itself been renamed must not
 * make every channel inside it read as having moved — that would turn one drift into
 * a dozen and bury the actual change.
 *
 * A declaration with no `parentKey` states no opinion about where the object lives, so
 * an operator filing a top-level channel under a category of their own is not drift.
 * That is the same principle as the extra-overwrites rule below: the declaration says
 * what must be true, not what must be absent.
 */
function detectReparent(input: ResourceDriftInput): ResourceDriftKind | undefined {
    const { declaration, live, declaredParentId } = input;

    // Roles have no parent, and a declaration that names none has no expectation.
    if (declaration.kind === 'role' || !declaration.parentKey) return undefined;

    // The parent is declared but not yet bound — install has not created it. Not
    // comparable, and reporting it would duplicate what the install plan already says.
    if (declaredParentId === undefined) return undefined;

    if (live.parentId === declaredParentId) return undefined;

    return {
        kind: 'reparented',
        declaredParentId,
        actualParentId: live.parentId,
    };
}

interface PermissionDriftResult {
    readonly difference?: ResourceDriftKind;
    readonly skipped?: string;
}

/**
 * Whether the live overwrites still satisfy the compiled declaration.
 *
 * Four rules, each of which was chosen deliberately and each of which is a test:
 *
 * **Only ids the declaration mentions are compared.** An operator granting one extra
 * person access is their business — the declaration states what must be true, not what
 * must be absent. Reporting every hand-added overwrite as drift would make the report
 * unreadable on a real guild, which trains the operator to ignore it, which is worse
 * than not having it.
 *
 * **The bot's own overwrite is excluded**, because `compilePermissionIntents` appends
 * it unconditionally rather than from an authored intent.
 *
 * **Bit sets are compared, never the raw bitfield.** Discord returns allow and deny as
 * bitfields carrying bits we never set — a channel's `ManageMessages`, say. Equality on
 * the serialised number would report drift on every channel, forever. The question is
 * *for each bit the declaration allows, is it allowed live; for each bit it denies, is
 * it denied live*, and nothing else.
 *
 * **An uncompilable declaration is skipped with a reason**, never reported clean. A
 * `subject` audience names a per-run member and cannot resolve outside a run.
 */
function detectPermissionDrift(input: ResourceDriftInput): PermissionDriftResult {
    const { declaration, live, compiledOverwrites, botId } = input;

    // Roles carry no overwrites, and a declaration with no intents inherits from its
    // parent — in both cases there is nothing that could have drifted.
    if (declaration.kind === 'role' || !declaration.permissions?.length) return {};

    if (!compiledOverwrites) {
        return {
            skipped: `The permission model for "${declaration.key}" could not be compiled outside a run, so its overwrites were not checked. An intent naming \`subject\` refers to a per-run member and has no meaning while provisioning shared guild structure.`,
        };
    }

    const liveById = new Map((live.overwrites ?? []).map((entry) => [entry.id, entry] as const));
    const differences: PermissionDifference[] = [];

    for (const declared of compiledOverwrites) {
        if (declared.id === botId) continue;

        const actual = liveById.get(declared.id);
        const declaredAllow = bitStrings(declared.allow);
        const declaredDeny = bitStrings(declared.deny);

        // No overwrite at all for a declared id: everything the declaration asked for
        // is missing. Reported as one difference listing all of it rather than as an
        // absence, so the repair and the render read the same way for both cases.
        const actualAllow = new Set(actual?.allow ?? []);
        const actualDeny = new Set(actual?.deny ?? []);

        const missingAllow = declaredAllow.filter((bit) => !actualAllow.has(bit));
        const missingDeny = declaredDeny.filter((bit) => !actualDeny.has(bit));

        if (missingAllow.length > 0 || missingDeny.length > 0) {
            differences.push({ id: declared.id, missingAllow, missingDeny });
        }
    }

    if (differences.length === 0) return {};
    return { difference: { kind: 'permissions', differences } };
}

/**
 * Permission bits as decimal strings.
 *
 * The comparison happens in string space because that is the form `discord.js`
 * serialises a `PermissionsBitField` to, and the live side arrives already serialised.
 * Converting the live side to `bigint` instead would mean parsing every bit of every
 * overwrite on the way in to reach the identical answer.
 */
function bitStrings(bits: readonly bigint[]): string[] {
    return bits.map((bit) => String(bit));
}

/** A one-line description of one drift, for a report an operator reads. */
export function describeDrift(drift: ResourceDriftKind, kind: ResourceKind): string {
    switch (drift.kind) {
        case 'renamed':
            return `Renamed from **${drift.declared}** to **${drift.actual}**.`;
        case 'reparented':
            return drift.actualParentId
                ? `Moved out of the category this journey put it in.`
                : `Moved out of its category to the top level.`;
        case 'wrongType':
            return `This binding now points at a ${drift.actual}, but the journey declares a ${KIND_LABEL[kind]}. It cannot be repaired automatically — re-bind it or create a replacement.`;
        case 'permissions': {
            const count = drift.differences.length;
            return `Permission overwrites no longer match for ${count === 1 ? '1 role or member' : `${count} roles or members`}.`;
        }
    }
}

/** Whether a report found anything. Reads better than `.drift.length > 0` at call sites. */
export function hasDrift(report: ResourceDriftReport): boolean {
    return report.drift.length > 0;
}
