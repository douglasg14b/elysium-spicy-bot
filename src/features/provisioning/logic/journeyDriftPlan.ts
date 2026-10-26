import { ChannelType, type Guild, type GuildBasedChannel } from 'discord.js';
import type { ButtonListener } from '../buttonListeners';
import { journeyOwner, type ResourceBindingEntity } from '../data/resourceBindingsSchema';
import { describeOtherHolder, type GuildOwnership } from './bindingOwner';
import { parseDeclaredRoleReference } from './declaredRoleReference';
import { describeChannel } from './installPlan';
import { isPostedMessageRow, requireMessagePresence, type MessagePresence, type PostedButton } from './lookupBoundMessage';
import { messageDigest } from './messageDrift';
import {
    compilePermissionIntents,
    PermissionIntentError,
    type PermissionIntent,
    type PermissionIntentContext,
} from './permissionIntent';
import {
    isDiscordResource,
    nonDiscordResourceKind,
    type DiscordResourceKind,
    type JourneyDeclaration,
    type ResourceDeclaration,
} from './resourceDeclaration';
import { normaliseResourceName } from './resourceName';
import {
    detectResourceDrift,
    hasDrift,
    type ButtonDisconnect,
    type CompiledOverwrite,
    type LiveOverwrite,
    type LiveResourceSnapshot,
    type ResourceDriftReport,
} from './resourceDrift';

/**
 * Read a guild and report which of a journey's resources have drifted.
 *
 * This is the impure half of drift: it does the Discord reading that
 * {@link detectResourceDrift} deliberately refuses to do, so that the comparison
 * itself stays a pure function over plain values. Everything interesting is in there;
 * this module assembles its inputs and fans it across a journey's bindings.
 *
 * ## What is deliberately not reported
 *
 * **A binding whose object is gone is not drift.** `buildInstallPlan` already detects
 * that and plans a recreate, saying so in the plan item's reason. Reporting the same
 * fact again in a second vocabulary would give the operator two surfaces describing
 * one situation, and — worse — two buttons that look like they do different things.
 *
 * **A resource with no binding is not drift either.** That is an install that has not
 * happened yet, which is the install plan's whole subject.
 *
 * So the question this module answers is narrow on purpose: *of the things we did
 * install and which are still there, which are no longer what we said they were.*
 *
 * **A message is compared by fingerprint, not against a live snapshot** — it has no name,
 * parent or overwrites to read, and only the bot can change it (`checkMessage`). It is the one
 * resource read from Discord here rather than from the cache, through the presence map its
 * caller fetched.
 */

export interface JourneyDriftPlan {
    readonly guildId: string;
    readonly journeyKey: string;
    /** Only resources that actually differ. A clean journey reports an empty array. */
    readonly drifted: readonly ResourceDriftReport[];
    /**
     * Resources checked and found to match, by key.
     *
     * Carried so a caller can say "checked 6, 2 drifted" rather than "2 drifted",
     * which is the difference between a report an operator trusts and a number they
     * have to go and verify.
     *
     * A resource appears here only when everything about it was *actually compared*.
     * One whose permissions could not be checked lands in {@link unchecked} instead —
     * see there for why the distinction is the whole point.
     */
    readonly cleanKeys: readonly string[];
    /**
     * Resources whose permissions could not be compared, each with its reason.
     *
     * **Not clean, and not drifted.** The third answer exists because collapsing it
     * into either of the other two is a lie in the direction that costs most: reported
     * clean, an unchecked staff-only channel is certified as private by a system that
     * never looked at it, which is the false-clean this whole feature exists to
     * prevent. Reported as drift, it would offer a repair that cannot be computed.
     *
     * The live instance is a `subject` audience, which names a per-run member and has
     * no meaning while provisioning shared guild structure. The other is a posted message
     * the bot could not read — a channel that shut it out — which is neither.
     */
    readonly unchecked: readonly UncheckedResource[];
}

/** A resource that was found, but whose permissions — or, for a message, whose post — could not be compared. */
export interface UncheckedResource {
    readonly resourceKey: string;
    readonly name: string;
    /** Why the comparison could not be made, in words an operator can act on. May carry `**bold**`. */
    readonly reason: string;
}

export interface BuildJourneyDriftPlanInput {
    readonly guild: Guild;
    readonly journey: JourneyDeclaration;
    /** This journey's rows, of every kind: a message's row is the only record of its post. */
    readonly bindings: readonly ResourceBindingEntity[];
    /**
     * Whether each posted message this journey still declares is still there, by resource key,
     * as `readMessagePresence` read it. Required whenever a declared message has a posted row:
     * the check throws rather than guess (`requireMessagePresence`).
     */
    readonly messagePresence?: ReadonlyMap<string, MessagePresence>;
    /**
     * The resource keys of found messages whose embeds somebody hid (SUPPRESS_EMBEDS), from
     * the same read as {@link messagePresence}. Absent means none.
     */
    readonly embedsSuppressed?: ReadonlySet<string>;
    /**
     * The `mbtn:` buttons each found message carries now, by resource key, from the same read
     * as {@link messagePresence}. Required when a found message's declaration has moved on:
     * what a repair takes away is what is posted and no longer declared.
     */
    readonly postedButtons?: ReadonlyMap<string, readonly PostedButton[]>;
    /**
     * Every trigger of this journey's flows naming one of its messages' buttons, through the
     * hook flows registers (`requireButtonListenerReader`), so an out-of-date message's report
     * can name the flows its repair would cut off. Required when a repair would take a posted
     * button away: the check throws rather than guess nobody listens.
     */
    readonly buttonListeners?: readonly ButtonListener[];
    /**
     * The same permission inputs the install preview takes.
     *
     * Required for the comparison to compile the declaration's intents into the
     * overwrites it expects to find. Without them every resource declaring permissions
     * reports as skipped — honest, but useless — so this is not optional the way it is
     * on `buildInstallPlan`, where a caller genuinely may not have them.
     */
    readonly permissionContext: Omit<PermissionIntentContext, 'guild'>;
    /**
     * Every binding in the guild, every owner's, with journey names.
     *
     * So a resource another owner also holds is reported with repair withheld and the
     * owner named (`ResourceDriftReport.sharedWith`). Required: the repair route rebuilds
     * its plan through here, so this is the fence, not a hint.
     */
    readonly ownership: GuildOwnership;
}

/**
 * Compare every bound resource in a journey against its declaration.
 *
 * Bindings are indexed by key and the walk is over *declarations*, not bindings. A
 * binding whose key the journey no longer declares is therefore skipped here — it is
 * an orphan, which is a teardown question ("this exists and nothing declares it; delete
 * or forget?") rather than a drift one. Answering it here would mean offering to
 * "repair" an object toward a declaration that does not exist.
 */
export function buildJourneyDriftPlan(input: BuildJourneyDriftPlanInput): JourneyDriftPlan {
    const { guild, journey, bindings, permissionContext, ownership } = input;
    const self = journeyOwner(journey.journeyKey);

    // Every kind, for a message's own row; Discord objects only for everything that resolves
    // a key to a snowflake — a parent, a role reference — so a row of another kind left under
    // such a key can never be read as one.
    const rowByKey = new Map(bindings.map((binding) => [binding.resourceKey, binding] as const));
    const bindingByKey = new Map(
        bindings.filter((binding) => isDiscordResource(binding)).map((binding) => [binding.resourceKey, binding] as const)
    );

    const drifted: ResourceDriftReport[] = [];
    const cleanKeys: string[] = [];
    const unchecked: UncheckedResource[] = [];

    for (const declaration of journey.resources) {
        if (!isDiscordResource(declaration)) {
            const kind = nonDiscordResourceKind(declaration.kind);
            switch (kind) {
                // A ticket type is never measured against its declaration: install uses an
                // existing type exactly as it stands and never changes one, so a difference
                // is not drift for anyone to repair.
                case 'ticketType':
                    continue;
                case 'message': {
                    const outcome = checkMessage({
                        guild,
                        declaration,
                        row: rowByKey.get(declaration.key),
                        declaredChannelId: declaration.parentKey
                            ? (bindingByKey.get(declaration.parentKey)?.discordId ?? undefined)
                            : undefined,
                        messagePresence: input.messagePresence,
                        embedsSuppressed: input.embedsSuppressed?.has(declaration.key) ?? false,
                        postedButtons: input.postedButtons,
                        buttonListeners: input.buttonListeners,
                    });
                    switch (outcome.status) {
                        case 'drifted':
                            drifted.push(outcome.report);
                            break;
                        case 'clean':
                            cleanKeys.push(declaration.key);
                            break;
                        case 'unchecked':
                            unchecked.push(outcome.entry);
                            break;
                        case 'install':
                            break;
                        default: {
                            const unreachable: never = outcome;
                            throw new Error(`Unhandled message check: ${String(unreachable)}`);
                        }
                    }
                    continue;
                }
                default: {
                    const unreachable: never = kind;
                    throw new Error(`Unhandled resource kind: ${String(unreachable)}`);
                }
            }
        }

        const binding = bindingByKey.get(declaration.key);

        // Never installed, or recorded but never reached the guild. Install's subject. (A
        // ticket type or message row under a key now declared as a channel names nothing in
        // the guild's cache either; install plans that key as new and rebinds the row, kind
        // and all.)
        if (!binding?.discordId || binding.state === 'intended' || !isDiscordResource(binding)) continue;

        const live = readLiveResource(guild, binding.kind, binding.discordId);

        // Gone from the guild. Install already plans the recreate; see the header.
        if (!live) continue;

        const compared = detectResourceDrift({
            declaration,
            binding,
            live,
            compiledOverwrites: compileForComparison(
                resolveDeclaredRoles(declaration.permissions, bindingByKey),
                { guild, ...permissionContext }
            ),
            declaredParentId: resolveDeclaredParentId(declaration.parentKey, bindingByKey),
            botId: guild.members.me?.id,
        });

        // Drift is still reported on a shared object — a public staff channel matters
        // whoever else uses it — but repair is withheld, so it cannot strip the overwrites
        // the other owner set.
        const sharedWith = describeOtherHolder(ownership, binding.discordId, self);
        const report = sharedWith ? { ...compared, repairable: false, sharedWith } : compared;

        /*
         * The two questions are independent, so they are asked independently rather
         * than as one three-way branch. A resource can be renamed *and* carry a
         * `subject` intent nobody could compile — it belongs in `drifted` for the
         * rename and in `unchecked` for the permissions, and a single if/else chain
         * would silently drop whichever it tested second.
         *
         * `cleanKeys` is the one that has to be conditional on both: a resource is
         * only clean when it drifted in nothing *and* nothing went unexamined.
         */
        if (hasDrift(report)) drifted.push(report);

        if (report.skippedPermissions) {
            unchecked.push({
                resourceKey: declaration.key,
                name: binding.name,
                reason: report.skippedPermissions,
            });
        }

        if (!hasDrift(report) && !report.skippedPermissions) {
            cleanKeys.push(declaration.key);
        }
    }

    return {
        guildId: guild.id,
        journeyKey: journey.journeyKey,
        drifted,
        cleanKeys,
        unchecked,
    };
}

interface CheckMessageInput {
    readonly guild: Guild;
    readonly declaration: ResourceDeclaration;
    /** The row under the message's key, of whatever kind. */
    readonly row: ResourceBindingEntity | undefined;
    /** The id the declared channel is bound to, or undefined when it has none (or no channel is declared). */
    readonly declaredChannelId: string | undefined;
    readonly messagePresence: ReadonlyMap<string, MessagePresence> | undefined;
    /** Whether somebody hid its embeds (SUPPRESS_EMBEDS), as the presence read found it. */
    readonly embedsSuppressed: boolean;
    readonly postedButtons: ReadonlyMap<string, readonly PostedButton[]> | undefined;
    readonly buttonListeners: readonly ButtonListener[] | undefined;
}

/** Where one declared message lands in the report — or `install`, when it is install's subject and none of drift's. */
type MessageCheck =
    | { readonly status: 'drifted'; readonly report: ResourceDriftReport }
    | { readonly status: 'clean' }
    | { readonly status: 'unchecked'; readonly entry: UncheckedResource }
    | { readonly status: 'install' };

/**
 * Whether a posted message still says what its declaration says, by fingerprint (`messageDigest`).
 *
 * Only the bot can edit its own message's content, so its content drifts only when its
 * declaration moves on, and the fingerprint stored at its post and after each repair is exact
 * (`messageDrift.ts`). The one thing anyone else can change is whether its embeds show:
 * somebody with Manage Messages can hide them ("Remove all embeds", SUPPRESS_EMBEDS), which
 * the fingerprint cannot see, so the presence read reports it. So:
 *
 *  - **never posted**, or posted and **gone** → install's: it posts it (again). Not drift, for
 *    the header's reason;
 *  - **posted in another channel** than the one now declared, or the declared channel not
 *    bound → install's too: Discord cannot move a message, and install blocks it saying so;
 *  - **unreadable** → `unchecked`, with why — neither clean nor drifted, which is what that
 *    list is for: certifying a message nobody could look at would be a false clean, and
 *    offering to repair it would edit blind;
 *  - **found**, fingerprint differs, or its embeds hidden → `outOfDate`, saying which,
 *    repairable: an adopted or shared message does not exist, and the repair's edit clears
 *    the flag;
 *  - **found**, same fingerprint, embeds showing → clean.
 *
 * A row with no fingerprint (written by something other than `upsertPostedMessage`) proves
 * nothing about what is posted, so it is out of date: repairing writes one, and harmlessly.
 */
function checkMessage(input: CheckMessageInput): MessageCheck {
    const { guild, declaration, row, declaredChannelId } = input;
    if (!row || row.kind !== 'message' || !isPostedMessageRow(row)) return { status: 'install' };

    const name = normaliseResourceName('message', declaration.defaultName);
    const presence = requireMessagePresence(input.messagePresence, row, 'its drift check was built');
    if (typeof presence === 'object') {
        return {
            status: 'unchecked',
            entry: {
                resourceKey: declaration.key,
                name,
                reason: `Couldn't check it in ${describeChannel(guild, row.messageChannelId)}: ${presence.unreadable}.`,
            },
        };
    }
    switch (presence) {
        case 'gone':
            return { status: 'install' };
        case 'found':
            break;
        default: {
            const unreachable: never = presence;
            throw new Error(`Unhandled message presence: ${String(unreachable)}`);
        }
    }

    if (!declaredChannelId || row.messageChannelId !== declaredChannelId) return { status: 'install' };

    if (!declaration.message) {
        // `validateJourneyDeclaration` requires one on every message resource, on every read.
        throw new Error(`Message resource "${declaration.key}" declares no message.`);
    }
    const declarationMoved = row.messageDigest !== messageDigest(declaration.message, declaration.buttons);
    if (!declarationMoved && !input.embedsSuppressed) return { status: 'clean' };

    // Only an edit toward a declaration that moved can take a button away: one that has not
    // moved is what is posted already.
    const disconnects = declarationMoved ? disconnectsOf(input, requirePostedButtons(input, row)) : [];
    return {
        status: 'drifted',
        report: {
            bindingId: row.id,
            resourceKey: declaration.key,
            name,
            kind: 'message',
            discordId: row.discordId,
            drift: [
                {
                    kind: 'outOfDate',
                    declarationMoved,
                    embedsHidden: input.embedsSuppressed,
                    ...(disconnects.length > 0 ? { disconnects } : {}),
                },
            ],
            repairable: true,
        },
    };
}

/** The buttons a found message carries, as the presence read fetched them, or throw rather than guess it has none. */
function requirePostedButtons(input: CheckMessageInput, row: ResourceBindingEntity): readonly PostedButton[] {
    const posted = input.postedButtons?.get(row.resourceKey);
    if (!posted) {
        throw new Error(
            `Journey "${row.ownerKey}" posted the message "${row.resourceKey}", but its drift check was built without the buttons it carries.`
        );
    }
    return posted;
}

/**
 * The triggers listening to a button the post carries now and its declaration no longer has —
 * the ones a repair, which edits the post to the declaration, would leave with nothing to
 * press, named by the label the post shows. Judged against the post as fetched: a listener
 * naming a button already gone from it (cut off by an earlier repair, or never posted) is
 * deaf already, and its flow's readiness says so rather than every later repair again.
 *
 * Listeners are asked for only when the post carries such a button, and throw when they were
 * not read: a report that named nobody because nobody asked would be a guess.
 */
function disconnectsOf(input: CheckMessageInput, posted: readonly PostedButton[]): ButtonDisconnect[] {
    const declaredButtons = new Set((input.declaration.buttons ?? []).map((button) => button.key));
    const leaving = posted.filter((button) => !declaredButtons.has(button.key));
    if (leaving.length === 0) return [];
    const listeners = input.buttonListeners;
    if (!listeners) {
        throw new Error(
            `Message resource "${input.declaration.key}" would lose buttons to a repair, but its drift check was built without reading who listens to them.`
        );
    }
    return leaving.flatMap((button) =>
        listeners
            .filter((listener) => listener.messageKey === input.declaration.key && listener.buttonKey === button.key)
            .map((listener) => ({ flowName: listener.flowName, buttonLabel: button.label }))
    );
}

/**
 * The snowflake of a declared parent, resolved through that parent's own binding.
 *
 * Three distinct answers, and the distinction is what keeps the reparent rule honest:
 * `null` means the declaration says "top level"; `undefined` means it names a parent
 * that is not bound yet, which is not comparable; a string is the parent's live id.
 *
 * `detectResourceDrift` treats `undefined` as "do not compare", so an install that has
 * created a child but not yet its category cannot report the child as having moved.
 */
function resolveDeclaredParentId(
    parentKey: string | undefined,
    bindingByKey: ReadonlyMap<string, ResourceBindingEntity>
): string | null | undefined {
    if (!parentKey) return null;
    return bindingByKey.get(parentKey)?.discordId ?? undefined;
}

/**
 * Swap `resource:<key>` role references for the ids those resources are bound to.
 *
 * A permission may name a role **this journey creates** — "this room is visible only
 * to the role this journey creates" is the shape 5A.1 exists to support. Install
 * resolves those against the ids it has just created (`resolveDeclaredRoles` in
 * `applyInstallPlan`); drift holds the same information in its bindings and has to do
 * the same, or `audienceToIds` finds `resource:approval-role` absent from the role
 * cache and throws.
 *
 * The consequence of not doing it is not a crash but something worse: the resource
 * lands in `unchecked` blaming a `subject` audience that is not involved, so the *most*
 * security-sensitive resources go permanently unexamined behind a misleading reason.
 *
 * **Unresolvable references are dropped rather than thrown on**, which is the one place
 * this deliberately differs from install. Install throws because creating a channel
 * whose permissions name a role that does not exist yet is an ordering bug it must
 * refuse. Here it just means the role has not been installed, which is install's
 * subject — and an intent left with no ids at all still fails to compile, landing in
 * `unchecked` where it belongs.
 */
export function resolveDeclaredRoles(
    permissions: readonly PermissionIntent[] | undefined,
    bindingByKey: ReadonlyMap<string, ResourceBindingEntity>
): readonly PermissionIntent[] | undefined {
    if (!permissions?.length) return permissions;

    return permissions.map((intent) => {
        if (!intent.roleIds?.length) return intent;

        let changed = false;
        const roleIds: string[] = [];

        for (const roleId of intent.roleIds) {
            const referencedKey = parseDeclaredRoleReference(roleId);
            if (!referencedKey) {
                roleIds.push(roleId);
                continue;
            }

            changed = true;
            const resolved = bindingByKey.get(referencedKey)?.discordId;
            if (resolved) roleIds.push(resolved);
        }

        return changed ? { ...intent, roleIds } : intent;
    });
}

/**
 * Compile a declaration's permission intents, or give up nameably.
 *
 * `compilePermissionIntents` throws a {@link PermissionIntentError} for a model that
 * cannot resolve outside a run — most importantly a `subject` audience, which names a
 * per-run member. Returning `undefined` routes that into the comparison's stated-skip
 * path rather than letting it surface as a failure of the whole report.
 *
 * Only `PermissionIntentError` is swallowed. Anything else is a real fault and is left
 * to propagate, because a drift report that silently degrades on an unexpected error
 * is precisely the false-clean this feature exists to prevent.
 */
export function compileForComparison(
    intents: JourneyDeclaration['resources'][number]['permissions'],
    context: PermissionIntentContext
): readonly CompiledOverwrite[] | undefined {
    if (!intents?.length) return undefined;

    try {
        return compilePermissionIntents(intents, context).map((overwrite) => ({
            id: String(overwrite.id),
            allow: toBigints(overwrite.allow),
            deny: toBigints(overwrite.deny),
        }));
    } catch (error) {
        if (error instanceof PermissionIntentError) return undefined;
        throw error;
    }
}

/** Narrow the compiler's bit arrays, which are typed loosely for `discord.js`. */
function toBigints(bits: unknown): bigint[] {
    if (!Array.isArray(bits)) return [];
    return bits.filter((bit): bit is bigint => typeof bit === 'bigint');
}

/**
 * What the guild currently holds for a bound resource, or `null` if it is gone.
 *
 * The live kind is reported as the *raw* channel type when it is not one this system
 * declares, rather than being narrowed away — the mismatch is one of the things being
 * detected, and discarding the evidence here would make `wrongType` unable to say what
 * the object actually is.
 */
function readLiveResource(
    guild: Guild,
    kind: DiscordResourceKind,
    discordId: string
): LiveResourceSnapshot | null {
    if (kind === 'role') {
        const role = guild.roles.cache.get(discordId);
        if (!role) return null;
        return { name: role.name, kind: 'role', parentId: null };
    }

    const channel = guild.channels.cache.get(discordId);
    if (!channel) return null;

    return {
        name: channel.name,
        kind: channelKind(channel),
        parentId: channel.parentId ?? null,
        overwrites: readOverwrites(channel),
    };
}

/** A channel's type as a {@link ResourceKind}, or a label when it is neither. */
function channelKind(channel: GuildBasedChannel): LiveResourceSnapshot['kind'] {
    switch (channel.type) {
        case ChannelType.GuildCategory:
            return 'category';
        case ChannelType.GuildText:
            return 'textChannel';
        default:
            return { unrecognised: ChannelType[channel.type] ?? String(channel.type) };
    }
}

/**
 * A channel's permission overwrites in the serialised form the comparison expects.
 *
 * `PermissionsBitField.toArray()` is deliberately *not* used: it returns permission
 * *names*, while the compiled side holds raw bits. Comparing names to bits would
 * report every overwrite as drifted, and comparing after a name lookup would add a
 * translation table that could drift from `discord.js` itself.
 */
function readOverwrites(channel: GuildBasedChannel): readonly LiveOverwrite[] {
    if (!('permissionOverwrites' in channel)) return [];

    return channel.permissionOverwrites.cache.map((overwrite) => ({
        id: overwrite.id,
        allow: splitBitfield(overwrite.allow.bitfield),
        deny: splitBitfield(overwrite.deny.bitfield),
    }));
}

/**
 * One bitfield as the individual set bits, each as a decimal string.
 *
 * The comparison asks "is every bit the declaration wants present here", which needs
 * the bits individually rather than as a combined field. Splitting once on the way in
 * is cheaper than testing each declared bit against the combined value with a mask,
 * and it makes a difference renderable — the report can name which bits are missing.
 *
 * **64 is the protocol's bound, not a guess.** Discord serialises a permission set as a
 * 64-bit integer in a string, so no flag can exist above bit 63. The highest today is
 * `PinMessages` at bit 51 (51 flags as of discord.js 14), leaving twelve spare — but
 * the loop is written to the protocol limit rather than to the current high-water mark
 * precisely so a new flag cannot silently fall off the end of it.
 */
function splitBitfield(bitfield: bigint): string[] {
    const bits: string[] = [];
    for (let position = 0n; position < 64n; position++) {
        const bit = 1n << position;
        if ((bitfield & bit) !== 0n) bits.push(String(bit));
    }
    return bits;
}
