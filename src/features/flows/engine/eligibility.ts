import { PermissionsBitField, type GuildMember, type PermissionResolvable } from 'discord.js';
import { z } from 'zod';
import type { FlowVariableValue } from '../blocks/types';

/**
 * Who is allowed to do a thing — the flow engine's one answer to "may they?".
 *
 * A single vocabulary evaluated by a single pure function. The alternative — each
 * dispatcher asking its own question — is how two surfaces end up with two
 * different ideas of who a moderator is, and how one of them ends up with no idea
 * at all, which is exactly where `flowTriggerDispatch` started.
 *
 * **Applied on the two button surfaces**: `flowTriggerDispatch` (starting a run)
 * and `flowChoiceDispatch` (answering a question). Deliberately *not* on
 * `memberJoinDispatch` or `reactionAddDispatch`, because neither
 * `trigger.memberJoin` nor `trigger.reactionAdd` declares the field — there is
 * nothing for those to read, and wiring a check for a field no block offers is a
 * layer built for a hypothetical.
 *
 * The consequence is worth stating plainly, because it is the failure this
 * centralised design exists to prevent: **a trigger block that adds the field
 * must also wire its own dispatcher.** Adding it to the schema alone would make
 * the rule authorable in the builder and silently inert at runtime — a form that
 * says "Moderators only", saves, draws a padlock on the card, and admits
 * everybody. That is the worst failure mode a permission check has, because
 * every layer reports success.
 *
 * So it is not left to this comment: {@link ELIGIBILITY_ENFORCED_SOURCES} names
 * the trigger sources a dispatcher actually checks, and conformance fails a
 * trigger that declares the field on any other one.
 *
 * **Deliberately no `moderator` principal.** Moderator roles belong in a shared
 * guild setting rather than in the flow engine's vocabulary, and that promotion
 * is not this step's work. `roles: [...]` already says "these roles" without the
 * engine naming a subsystem it does not own — and when the shared setting does
 * arrive, it can be expressed here without a migration of every saved graph.
 *
 * Refusal is always **ephemeral and changes nothing**: no role is assigned, no
 * run advances, no message is posted. The failure this exists to prevent is a
 * dead interaction, which Discord shows the presser as a red error.
 *
 * **Named `eligibility`, though the PRD calls the feature an "audience gate".**
 * Not a drift: `audience` is a proven rejection in `engineVocabulary.test.ts`,
 * because "the audience for this welcome message" is exactly the use-case noun
 * that gate exists to keep out of the interpreter. Admitting it would have
 * blinded the check to that leak to buy one word. `eligibility` is §5.4's own
 * term for the same thing and carries no product meaning.
 */

/**
 * The ways a gate can name who it admits.
 *
 * A closed union, and — like the block vocabularies — that is the extension
 * point: a gate that needs a principal this cannot express extends the list for
 * everyone rather than growing a special case at one call site.
 */
export const ELIGIBILITY_PRINCIPALS = [
    /** Nobody is turned away. The default, and what every saved graph means. */
    'anyone',
    /** Only the member the run is *about*. */
    'subject',
    /** Only the member who caused the current step. */
    'actor',
    /** Only the member whose id a named run variable holds. */
    'variable',
    /** Anybody holding at least one of the listed roles. */
    'roles',
    /** Anybody Discord grants at least one of the listed permissions. */
    'discordPermission',
] as const;

export type EligibilityPrincipal = (typeof ELIGIBILITY_PRINCIPALS)[number];

/**
 * Discord permissions a gate may name.
 *
 * A curated subset rather than all of `PermissionFlagsBits`, because this list is
 * offered to an author in a dropdown: the full set is ninety-odd flags, most of
 * which say nothing about whether somebody should be allowed to press a button.
 * These are the ones that actually read as "staff" to a guild owner.
 *
 * Extending it is a one-line change here; every consumer reads this array.
 */
export const ELIGIBILITY_PERMISSIONS = [
    'Administrator',
    'ManageGuild',
    'ManageRoles',
    'ManageChannels',
    'ManageMessages',
    'KickMembers',
    'BanMembers',
    'ModerateMembers',
] as const;

export type EligibilityPermission = (typeof ELIGIBILITY_PERMISSIONS)[number];

/**
 * An authored eligibility rule, as it is persisted in `node.data`.
 *
 * Discriminated on `principal` so each arm carries only what it needs — a
 * `roles` gate cannot forget its role list, and an `anyone` gate cannot smuggle
 * one in. The shape mirrors `BlockConfigField`'s, for the same reason.
 *
 * Every arm's extra is **required**, not optional. A `roles` gate with no roles
 * admits nobody, which an author would read as a gate that is merely unfinished
 * — and a gate that silently admits nobody is worse than one that refuses to
 * save, because it fails in front of a member rather than in the builder.
 */
export const eligibilitySchema = z.discriminatedUnion('principal', [
    z.object({ principal: z.literal('anyone') }),
    z.object({ principal: z.literal('subject') }),
    z.object({ principal: z.literal('actor') }),
    z.object({
        principal: z.literal('variable'),
        /** Name of a run variable holding the admitted member's user id. */
        variable: z.string().min(1),
    }),
    z.object({
        principal: z.literal('roles'),
        /** Role ids; holding **any** one of them admits. */
        roleIds: z.array(z.string().min(1)).min(1),
    }),
    z.object({
        principal: z.literal('discordPermission'),
        /** Permission names; holding **any** one of them admits. */
        permissions: z.array(z.enum(ELIGIBILITY_PERMISSIONS)).min(1),
    }),
]);

export type Eligibility = z.infer<typeof eligibilitySchema>;

/**
 * What every gate means when an author has not set one.
 *
 * Load-bearing compatibility, not a convenience: every trigger button already
 * deployed in a guild was authored before gates existed, and reading an absent
 * gate as anything but "anyone" would silently stop working flows the moment
 * this ships.
 */
export const OPEN_GATE: Eligibility = { principal: 'anyone' };

/**
 * The `node.data` key a gate is stored under, for every block that declares one.
 *
 * One key across every block rather than a name each block picks, because
 * `readEligibility` is how a dispatcher reads a gate off a graph it has not
 * validated — and it can only do that without knowing the block type if the key
 * is the same everywhere.
 */
export const ELIGIBILITY_CONFIG_KEY = 'eligibility';

/**
 * The trigger sources whose dispatcher actually consults a rule.
 *
 * The enforcement half of the module doc above, as data rather than as advice.
 * `checkBlockConformance` reads it, so a trigger declaring the eligibility field
 * on a source no dispatcher checks fails a test that already runs over every
 * block — rather than shipping a permission control that admits everybody.
 *
 * **Adding a source here is a claim about the dispatcher, not about the block.**
 * It is only true once that dispatcher calls {@link readEligibility} and refuses
 * on the result; listing one before that is how the silent failure gets in.
 *
 * `memberJoin` is the one most likely to arrive next, and it needs more than a
 * wire-up: §5.4's "already completed" rule wants a durable per-member journey
 * record that does not exist yet.
 */
export const ELIGIBILITY_ENFORCED_SOURCES = ['buttonClick'] as const;

/**
 * The gate as a block's config schema declares it.
 *
 * `.default()` rather than `.optional()`: a block reading `config.eligibility`
 * always gets a gate, so no call site has to remember what absent means. The
 * builder seeds the same value through the field's own `defaultValue`, and
 * `checkFieldDefault` holds the two together.
 */
export const eligibilityConfigSchema = eligibilitySchema.default(OPEN_GATE);

/**
 * Read a gate off a node's raw, persisted `data`.
 *
 * A dispatcher holds `node.data` as it came out of the database, not as a
 * block's schema validated it — so this cannot assume a well-formed gate. Three
 * things arrive here and only one of them is an error:
 *
 * * **No key at all** — every graph authored before gates existed. Open.
 * * **A valid gate** — the author set one. Used as written.
 * * **Something else** — a key holding a shape the schema rejects, which is only
 *   reachable by writing to the database directly, since save-time validation
 *   refuses it. Reported as `null`, and every caller must refuse on it.
 *
 * That last asymmetry is the whole reason this is a function rather than a cast.
 * Absent means open because absence has a known, documented meaning; malformed
 * means nothing at all, and the safe reading of an unknown gate on a security
 * check is the restrictive one.
 *
 * `null` rather than a closed sentinel gate so the caller has to handle it, and
 * so the member gets {@link UNREADABLE_GATE_MESSAGE} rather than a refusal
 * naming a condition the flow never actually set.
 */
export function readEligibility(data: unknown): Eligibility | null {
    const raw =
        data && typeof data === 'object'
            ? (data as Record<string, unknown>)[ELIGIBILITY_CONFIG_KEY]
            : undefined;
    if (raw === undefined) {
        return OPEN_GATE;
    }

    const parsed = eligibilitySchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

/**
 * What a member is told when their gate could not be read.
 *
 * Says plainly that the flow is misconfigured rather than inventing a condition
 * they failed: reporting an unreadable gate as "you don't have the role" would
 * send somebody to a mod asking for a role the flow never named.
 */
export const UNREADABLE_GATE_MESSAGE =
    "This flow's permissions are set up wrong, so nothing ran. A mod will need to look at it.";

/**
 * What a gate is evaluated against.
 *
 * Deliberately **not** a `FlowRunContext`: the trigger dispatcher evaluates a
 * gate before any run exists, so requiring a run context would force it to
 * invent one. What a gate actually reads is a candidate member and the run's
 * identity facts, which a dispatcher can supply honestly or leave absent.
 */
export interface EligibilityFacts {
    /** The member whose admission is in question. */
    readonly candidate: GuildMember;
    /**
     * The member the run is about, when there is a run.
     *
     * Absent before a run starts. A `subject` gate evaluated with no subject
     * refuses rather than admitting — see {@link evaluateEligibility}.
     */
    readonly subject?: GuildMember;
    /** The member who caused the current step, when a member caused it. */
    readonly actor?: GuildMember;
    /** The run's variables, for a `variable` gate to read an id out of. */
    readonly variables?: Readonly<Record<string, FlowVariableValue>>;
}

/**
 * Whether a gate admits, and the reason when it does not.
 *
 * The reason is **for the member**, not for the log: it is shown to whoever was
 * turned away, so it says what would have let them through without naming role
 * ids or variable names they cannot see the point of.
 */
export type EligibilityDecision =
    | { readonly allowed: true }
    | { readonly allowed: false; readonly reason: string };

const ADMITTED: EligibilityDecision = { allowed: true };

/**
 * Does this gate admit this member?
 *
 * A pure function over a member and the run's facts — no Discord fetches, no
 * database, no interaction. That is what makes it testable at every principal
 * without a live guild, and it is why the plan puts it here rather than inside
 * the interaction handler.
 *
 * **Every unsatisfiable gate refuses.** A `subject` gate with no subject, a
 * `variable` gate naming a variable that is unset or holds something that is not
 * an id — each of those is a gate whose condition cannot be shown to hold, and a
 * gate that admits when it cannot tell is not a gate. The cost of refusing
 * wrongly is a member who has to ask a mod; the cost of admitting wrongly is the
 * thing the gate exists to prevent.
 */
export function evaluateEligibility(gate: Eligibility, facts: EligibilityFacts): EligibilityDecision {
    switch (gate.principal) {
        case 'anyone':
            return ADMITTED;

        case 'subject':
            return facts.subject && facts.subject.id === facts.candidate.id
                ? ADMITTED
                : { allowed: false, reason: 'This is only for the person this flow is about.' };

        case 'actor':
            return facts.actor && facts.actor.id === facts.candidate.id
                ? ADMITTED
                : { allowed: false, reason: 'This is only for whoever set this step going.' };

        case 'variable': {
            // Compared as a string and never coerced. A variable holding a number
            // is a user id that already lost precision passing through JSON — a
            // snowflake past 2^53 is not the id it started as — so stringifying
            // it would compare a corrupted id and could admit on a near miss.
            const held = facts.variables?.[gate.variable];
            return typeof held === 'string' && held === facts.candidate.id
                ? ADMITTED
                : { allowed: false, reason: 'This is meant for somebody else.' };
        }

        case 'roles':
            return gate.roleIds.some((roleId) => facts.candidate.roles.cache.has(roleId))
                ? ADMITTED
                : { allowed: false, reason: "You don't have the role this needs." };

        case 'discordPermission':
            return hasAnyPermission(facts.candidate, gate.permissions)
                ? ADMITTED
                : { allowed: false, reason: "You don't have permission to do this." };
    }
}

/**
 * Does the member hold at least one of these permissions?
 *
 * `permissions` on a `GuildMember` is the **effective** set — every role's
 * grants, plus the owner and administrator overrides discord.js applies for us.
 * Reading role grants by hand would miss both, which is the difference between a
 * gate a guild owner can pass and one they cannot.
 *
 * Channel overwrites are deliberately not consulted: a gate says who somebody
 * *is* in the guild, not where they are standing, and the same gate is evaluated
 * on a member-join path where there is no channel to ask about.
 */
function hasAnyPermission(
    member: GuildMember,
    permissions: readonly EligibilityPermission[]
): boolean {
    const held = member.permissions;
    return permissions.some((permission) =>
        held.has(PermissionsBitField.Flags[permission] satisfies PermissionResolvable)
    );
}
