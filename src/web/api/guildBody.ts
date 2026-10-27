import { z } from '@hono/zod-openapi';
import { ChannelType, type Guild, type GuildBasedChannel } from 'discord.js';
import { describeOwner, ownerOf, type GuildOwnership } from '../../features/provisioning';
// From its defining module, not the barrel: `z.enum` reads it while this module loads.
import { BINDING_OWNER_KINDS } from '../../features/provisioning/data/resourceBindingsSchema';

/**
 * The guild shapes the browser receives.
 *
 * Extracted from `guildRoutes.ts`'s inline `.map()` callbacks so the wire shape is a
 * named contract rather than something you discover by reading a request — the same
 * reason `driftBody.ts` and `publishedBody.ts` exist.
 *
 * Each shape is a zod schema, and the schema **is** the contract: `guildRoutes` declares
 * it as the route's response, `app.openapi` type-checks every `c.json(...)` against it,
 * and the OpenAPI spec the dashboard SDK is generated from names it as a component. The
 * types below are inferred from the schemas rather than written beside them, so there is
 * no second copy to drift. The `.openapi('Name')` ids are component names the browser
 * imports by, so renaming one renames a generated type.
 *
 * ## Why `type` had to be added
 *
 * `GET /channels` used to return text channels only, as `{id, name}`. That made two
 * things impossible and one thing dangerous:
 *
 *  - **Two channels called `#general` were indistinguishable.** The operator picked one
 *    of two identical rows and found out later which.
 *  - **A category could not be adopted at all.** The install model adopts all three
 *    kinds; the picker could not offer what the endpoint never sent. (Roles were the
 *    same gap with a different cause — they come from `GET /roles`, and the panel
 *    simply never handed that list to a picker. `adoptableRoleOptions` closes it.)
 *  - And the *absence* of a type was load-bearing in a place nobody had written down:
 *    `ChannelPickerControl` maps every channel it is given into "somewhere to post",
 *    with a comment claiming categories are excluded. They were — by this endpoint's
 *    filter, two files away. Sending categories without giving the browser a way to
 *    tell them apart would have offered a category as a place to post a message, which
 *    fails at runtime in a live guild after publish.
 *
 * So `type` is **required**, not optional. A consumer that must not offer a category
 * now has a field to filter on, and adding the field as required is what makes every
 * existing `.map()` over a channel list a place the compiler points at.
 */

/**
 * The channel kinds this endpoint reports.
 *
 * A closed vocabulary rather than discord.js's numeric `ChannelType`, because the
 * browser must not carry a copy of that enum and only these two mean anything to a
 * flow or a declaration. Everything else — voice, stage, forum, thread — is filtered
 * out rather than labelled, since nothing in the product can target one.
 *
 * ## Why announcement channels are not in this list
 *
 * They were, briefly, and it was wrong — not because an announcement channel is
 * unusable, but because **this endpoint is not where that question gets answered.**
 * Three places already disagreed about which channels a flow may use:
 *
 *  - `actionSendMessage` / `actionPostEmbed` ask `isTextBased() && 'send' in channel`,
 *    a capability check an announcement channel passes.
 *  - `deployFlowButtons` (retired since) refused anything but `ChannelType.GuildText`.
 *  - `existsInGuildAs`, which gates adoption, does the same.
 *
 * Listing `announcement` here added a *fourth* opinion and matched none of them: the
 * picker offered one, the declaration passed every save-time check, and the apply threw
 * in `requireAdoptable` after earlier resources had really been created — the
 * half-applied state the up-front validation exists to prevent.
 *
 * The directory now reports what the strictest consumer accepts. Widening it again
 * means first giving the product one answer to "may a flow use this channel?" and making
 * both remaining sites ask it; until then, a type this endpoint does not send is a type no
 * picker can offer, which is the honest failure.
 */
export const GUILD_CHANNEL_TYPES = ['text', 'category'] as const;
export type GuildChannelType = (typeof GUILD_CHANNEL_TYPES)[number];

/** A guild the bot is in that the signed-in user may manage. */
export const GuildSchema = z
    .object({
        id: z.string(),
        name: z.string(),
        iconURL: z.string().nullable(),
        memberCount: z.number(),
    })
    .openapi('Guild');

/** Named so the pickers can compare `owner.kind` off the generated type. */
const BindingOwnerKindSchema = z.enum(BINDING_OWNER_KINDS).openapi('BindingOwnerKind');

/**
 * Who already holds a channel, category or role: a journey, or the ticket system.
 *
 * `kind` and `key` let a picker tell its *own* holdings (the journey being edited) from
 * someone else's; `label` is how the operator is told, written server-side so every
 * surface names an owner the same way ("the ticket system", `journey "Onboarding"`).
 *
 * **One owner, the first in `(kind, key)` order.** Two can hold an object only through a
 * cross-claim from before the one-owner rule (the 2026-10-10 migration logs them). There
 * a picker may judge it by the wrong one; the server, which excludes the asker, decides.
 */
const GuildObjectOwnerSchema = z
    .object({
        kind: BindingOwnerKindSchema,
        key: z.string(),
        /** Server-written: "the ticket system", `journey "Onboarding"`. Shown as it is. */
        label: z.string(),
    })
    .openapi('GuildObjectOwner', {
        description:
            'Who already holds a channel, category or role: a journey (by key) or the ticket system. ' +
            '`label` names the owner for the operator.',
    });

export type GuildObjectOwnerBody = z.infer<typeof GuildObjectOwnerSchema>;

export const GuildChannelSchema = z
    .object({
        id: z.string(),
        name: z.string(),
        type: z.enum(GUILD_CHANNEL_TYPES),
        /** The category this sits in, or null at the top level. Always null for a category. */
        parentId: z.string().nullable(),
        /**
         * The category's name, resolved here rather than in the browser.
         *
         * The browser holds the same list and could look it up, but only after the whole
         * list has loaded and only if the parent is in it — and the parent is filtered out
         * of nothing today, which is exactly the kind of "true for now" the endpoint should
         * not make a caller depend on. Sending the name makes a row self-describing.
         */
        parentName: z.string().nullable(),
        /**
         * The owner holding a settled binding for this channel, or null when nobody does.
         *
         * A category or channel belongs to one owner (2026-10-10), so the pickers disable one
         * held by somebody else rather than offering an adoption the server refuses. Null for
         * an object only an `intended` row names — that row has no id yet. A union rather
         * than `.nullable()`: the generator copies a named schema's name onto its nullable.
         */
        owner: z.union([GuildObjectOwnerSchema, z.null()]),
    })
    .openapi('GuildChannel');

export type GuildChannelBody = z.infer<typeof GuildChannelSchema>;

/** A role a flow may grant: neither `@everyone` nor bot-managed. */
export const GuildRoleSchema = z
    .object({
        id: z.string(),
        name: z.string(),
        /** Discord role colour as a 24-bit int. `0` means "no colour" (inherit). */
        color: z.number(),
        position: z.number(),
        /**
         * The owner holding a settled binding for this role, or null — as on a channel. A
         * journey can bind a role, and the install plan refuses to adopt one another owner
         * holds, so the role picker has to know too or it offers what install will block.
         */
        owner: z.union([GuildObjectOwnerSchema, z.null()]),
    })
    .openapi('GuildRole');

export type GuildRoleBody = z.infer<typeof GuildRoleSchema>;

/** One of the server's own emoji, as a message button's emoji picker offers it. */
export const GuildEmojiSchema = z
    .object({
        id: z.string(),
        name: z.string(),
        animated: z.boolean(),
    })
    .openapi('GuildEmoji', {
        description:
            "One of the server's own emoji a button may show. Drawn from `cdn.discordapp.com/emojis/<id>`, " +
            'a GIF when `animated`.',
    });

export type GuildEmojiBody = z.infer<typeof GuildEmojiSchema>;

/** The warnings mod-log channel, with its name resolved for display. */
export const WarningsConfigSchema = z
    .object({
        modChannelId: z.string().nullable(),
        modChannelName: z.string().nullable(),
    })
    .openapi('WarningsConfig');

export type WarningsConfigBody = z.infer<typeof WarningsConfigSchema>;

/**
 * Server-wide settings owned by no single feature. Today: staff roles and the time zone.
 *
 * `staffRoles` resolves the saved ids to names for display and can be **shorter** than
 * `staffRoleIds`: a role deleted since it was saved has no name to show but is still
 * stored, so the saved list is reported as saved rather than rewritten by a read. Render
 * from `staffRoleIds`, label from `staffRoles`.
 *
 * Staff roles are their own concept on this server, deliberately distinct from tickets'
 * moderation roles. The two lists coexist; neither supersedes the other.
 *
 * The rendering rule is also the spec's description, so it reaches the generated type
 * the dashboard reads rather than staying on this side.
 */
export const GuildSettingsSchema = z
    .object({
        staffRoleIds: z.array(z.string()),
        staffRoles: z.array(z.object({ id: z.string(), name: z.string() })),
        /** The picked zone (an IANA name), `null` until someone picks one. */
        timeZone: z.string().nullable(),
        /** What an unpicked zone means, so the dashboard can say so without its own copy. */
        defaultTimeZone: z.string(),
    })
    .openapi('GuildSettings', {
        description:
            'Staff roles, as saved. `staffRoles` names the ids that still resolve to a role and can be ' +
            'shorter than `staffRoleIds`, since a deleted role stays saved: render from `staffRoleIds`, ' +
            'label from `staffRoles`. `timeZone` is the picked IANA zone, null until someone picks one; ' +
            '`defaultTimeZone` is the zone an unpicked server runs on.',
    });

export type GuildSettingsBody = z.infer<typeof GuildSettingsSchema>;

/**
 * Which of a channel's types the browser is told about, or `undefined` to omit it.
 *
 * Announcement channels fall through to `undefined` along with voice, stage and forum.
 * That is deliberate and is **not** a claim that a flow could not post in one — see the
 * note on `GUILD_CHANNEL_TYPES`. It is that provisioning refuses anything but `GuildText`,
 * and a directory that offers what it rejects produces a declaration that fails after the
 * apply has already started.
 */
function channelTypeOf(channel: GuildBasedChannel): GuildChannelType | undefined {
    switch (channel.type) {
        case ChannelType.GuildText:
            return 'text';
        case ChannelType.GuildCategory:
            return 'category';
        default:
            return undefined;
    }
}

/**
 * The guild's channels, as the directory reports them.
 *
 * Sorted by name for stable display, as before. Categories now appear alongside
 * channels rather than being filtered out — every consumer that must not treat one as
 * postable filters on `type`, which is the point of sending it.
 *
 * `ownership` is the guild's bindings, read once by the route, so each channel's `owner`
 * costs no query of its own.
 */
export function guildChannelBodies(guild: Guild, ownership: GuildOwnership): GuildChannelBody[] {
    const channels = [...guild.channels.cache.values()];
    const nameById = new Map(channels.map((channel) => [channel.id, channel.name]));

    return channels
        .flatMap((channel) => {
            const type = channelTypeOf(channel);
            if (!type) return [];

            // A category has no parent of its own, and Discord reports `parentId` as
            // null for one anyway — stated rather than relied upon, because a category
            // claiming a parent would read as a nested category, which cannot exist.
            const parentId = type === 'category' ? null : channel.parentId ?? null;

            return [
                {
                    id: channel.id,
                    name: channel.name,
                    type,
                    parentId,
                    parentName: parentId ? nameById.get(parentId) ?? null : null,
                    owner: guildObjectOwner(ownership, channel.id),
                } satisfies GuildChannelBody,
            ];
        })
        .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Who holds a guild object, as the directory reports it — the one place a channel's or a
 * role's `owner` is built, so both name owners the same way.
 */
export function guildObjectOwner(ownership: GuildOwnership, discordId: string): GuildObjectOwnerBody | null {
    const owner = ownerOf(ownership.bindings, discordId);
    return owner ? { kind: owner.kind, key: owner.key, label: describeOwner(owner, ownership.journeyNames) } : null;
}

/**
 * Ceilings on a role-id list a request sends — the staff roles and the ticket moderation
 * roles. A snowflake is at most 20 characters and no server has 50 such roles, so both are
 * generous; they exist because each id is looked up and a refused one is named back.
 */
export const ROLE_LIST_MAX = 50;
export const ROLE_ID_MAX_LENGTH = 32;
