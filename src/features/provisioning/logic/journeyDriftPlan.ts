import { ChannelType, type Guild, type GuildBasedChannel } from 'discord.js';
import type { ResourceBindingEntity } from '../data/resourceBindingsSchema';
import {
    compilePermissionIntents,
    PermissionIntentError,
    type PermissionIntentContext,
} from './permissionIntent';
import type { JourneyDeclaration, ResourceKind } from './resourceDeclaration';
import {
    detectResourceDrift,
    hasDrift,
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
     * no meaning while provisioning shared guild structure.
     */
    readonly unchecked: readonly UncheckedResource[];
}

/** A resource that was found, but whose permissions could not be compared. */
export interface UncheckedResource {
    readonly resourceKey: string;
    readonly name: string;
    /** Why the comparison could not be made, in words an operator can act on. */
    readonly reason: string;
}

export interface BuildJourneyDriftPlanInput {
    readonly guild: Guild;
    readonly journey: JourneyDeclaration;
    readonly bindings: readonly ResourceBindingEntity[];
    /**
     * The same permission inputs the install preview takes.
     *
     * Required for the comparison to compile the declaration's intents into the
     * overwrites it expects to find. Without them every resource declaring permissions
     * reports as skipped — honest, but useless — so this is not optional the way it is
     * on `buildInstallPlan`, where a caller genuinely may not have them.
     */
    readonly permissionContext: Omit<PermissionIntentContext, 'guild'>;
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
    const { guild, journey, bindings, permissionContext } = input;

    const bindingByKey = new Map(
        bindings.map((binding) => [binding.resourceKey, binding] as const)
    );

    const drifted: ResourceDriftReport[] = [];
    const cleanKeys: string[] = [];
    const unchecked: UncheckedResource[] = [];

    for (const declaration of journey.resources) {
        const binding = bindingByKey.get(declaration.key);

        // Never installed, or recorded but never reached the guild. Install's subject.
        if (!binding?.discordId || binding.state === 'intended') continue;

        const live = readLiveResource(guild, binding.kind, binding.discordId);

        // Gone from the guild. Install already plans the recreate; see the header.
        if (!live) continue;

        const report = detectResourceDrift({
            declaration,
            binding,
            live,
            compiledOverwrites: compileForComparison(declaration.permissions, {
                guild,
                ...permissionContext,
            }),
            declaredParentId: resolveDeclaredParentId(declaration.parentKey, bindingByKey),
            botId: guild.members.me?.id,
        });

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
function compileForComparison(
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
    kind: ResourceKind,
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
 */
function splitBitfield(bitfield: bigint): string[] {
    const bits: string[] = [];
    for (let position = 0n; position < 64n; position++) {
        const bit = 1n << position;
        if ((bitfield & bit) !== 0n) bits.push(String(bit));
    }
    return bits;
}
