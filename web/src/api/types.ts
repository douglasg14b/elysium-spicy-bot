/**
 * Shapes returned by the BrattyBot API. Kept in sync with `src/web/api/*` by hand,
 * with one exception: {@link NodeDescriptor} and the block vocabularies around it
 * are held to the server's block manifest by
 * `src/web/api/__tests__/nodeDescriptorDrift.test.ts`, which fails naming the field
 * or the union whenever the two disagree.
 *
 * The mirror is hand-written because it has to be. A single `import type` from
 * `src/` inside this workspace drags the whole bot tree into `tsc -b` — the first
 * half of `pnpm build:web` — and the build fails. This is the one file where that
 * trade is made, and the drift test is the price of making it.
 */

export interface AuthUser {
    id: string;
    username: string;
    avatar: string | null;
}

/** Which bot application the dashboard is connected to. */
export type BotFlavour = 'development' | 'production';

/**
 * Identity of the connected bot account. Every field but `ready` is null while the
 * Discord gateway is still connecting — the web server accepts requests before login
 * completes — and the UI shows its bundled branding until then.
 */
export interface BotIdentity {
    ready: boolean;
    id: string | null;
    username: string | null;
    flavour: BotFlavour | null;
}

export interface Guild {
    id: string;
    name: string;
    iconURL: string | null;
    memberCount: number;
}

export interface GuildChannel {
    id: string;
    name: string;
}

export interface WarningsConfig {
    modChannelId: string | null;
    modChannelName: string | null;
}

/**
 * Server-wide settings owned by no single feature, from
 * `GET /api/guilds/:guildId/settings`.
 *
 * `staffRoles` resolves the saved ids to names for display and can be **shorter**
 * than `staffRoleIds`: a role deleted since it was saved has no name to show but is
 * still stored, so the saved list is reported as saved rather than rewritten by a
 * read. Render from `staffRoleIds`, label from `staffRoles`.
 *
 * Staff roles are their own concept on this server, deliberately distinct from
 * tickets' moderation roles. The two lists coexist; neither supersedes the other.
 */
export interface GuildSettings {
    staffRoleIds: string[];
    staffRoles: { id: string; name: string }[];
}

/** A role as returned by `GET /api/guilds/:guildId/roles`. */
export interface GuildRole {
    id: string;
    name: string;
    /** Discord role colour as a 24-bit int. `0` means "no colour" (inherit). */
    color: number;
    position: number;
}

/* ------------------------------------------------------------------ *
 * Flows
 * ------------------------------------------------------------------ */

/**
 * The block vocabularies, mirroring the server's closed unions.
 *
 * Declared `as const` arrays rather than bare unions so the drift test can compare
 * them against the server's own constants as **data**, member by member — a widened
 * vocabulary is otherwise invisible to a check that only compares field names.
 */
export const NODE_KINDS = ['trigger', 'condition', 'action'] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

/** Palette section a block is offered in. */
export const BLOCK_PALETTE_GROUPS = ['triggers', 'conditions', 'actions'] as const;

export type BlockPaletteGroup = (typeof BLOCK_PALETTE_GROUPS)[number];

/** What makes a trigger fire. Set by triggers and by nothing else. */
export const BLOCK_TRIGGER_SOURCES = ['buttonClick', 'memberJoin', 'reactionAdd'] as const;

export type BlockTriggerSource = (typeof BLOCK_TRIGGER_SOURCES)[number];

/** The editor widget a config field asks for. Each is implemented once here. */
export const BLOCK_CONTROL_TYPES = [
    'rolePicker',
    'channelPicker',
    'text',
    'longText',
    'duration',
    'segmented',
    'select',
    'colour',
    'textList',
    'objectList',
    'eligibility',
] as const;

export type BlockControlType = (typeof BLOCK_CONTROL_TYPES)[number];

/**
 * The eligibility vocabularies, mirroring `src/features/flows/engine/eligibility.ts`.
 *
 * Declared here rather than imported for the reason the whole file exists: the
 * server's copy reaches `discord.js` through its schema, and pulling that into the
 * browser would drag the bot tree into the web build. The drift test compares the
 * two as data.
 */
export const ELIGIBILITY_PRINCIPALS = [
    'anyone',
    'subject',
    'actor',
    'variable',
    'roles',
    'discordPermission',
] as const;

export type EligibilityPrincipal = (typeof ELIGIBILITY_PRINCIPALS)[number];

/** Discord permissions a gate may name — a curated subset, not every flag. */
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
 * An authored eligibility rule, as it is stored in `node.data`.
 *
 * Discriminated on `principal`, so each arm carries only its own extra — which is
 * what lets the control render one set of inputs per choice without a lookup
 * table saying which extras belong to which principal.
 */
export type Eligibility =
    | { principal: 'anyone' }
    | { principal: 'subject' }
    | { principal: 'actor' }
    | { principal: 'variable'; variable: string }
    | { principal: 'roles'; roleIds: string[] }
    | { principal: 'discordPermission'; permissions: EligibilityPermission[] };

/** One choice offered by a `segmented` or `select` control. */
export interface BlockConfigOption {
    /** The value persisted in `node.data`. */
    value: string;
    label: string;
}

/**
 * One column of an `objectList` entry — a named input on every row.
 *
 * Text and a checkbox only. Not a nested control vocabulary: a column asking for a
 * picker would be a form inside a list row, which is a different control with a
 * different layout problem rather than a wider member here.
 */
/** The widgets one `objectList` column may ask for. A vocabulary of its own. */
export const BLOCK_COLUMN_CONTROLS = ['text', 'longText', 'toggle'] as const;

export type BlockColumnControl = (typeof BLOCK_COLUMN_CONTROLS)[number];

export interface BlockConfigColumn {
    /** The key this column edits **inside one entry**, e.g. `name`. */
    key: string;
    label: string;
    control: BlockColumnControl;
    /** Hint shown in this column's empty input. Never on a `toggle`. */
    placeholder?: string;
    /** Maximum characters of this column's value, on one entry. */
    maxLength?: number;
    /** Whether this column's `{{tokens}}` are expanded before the block runs. */
    rendersTokens?: boolean;
}

interface BlockConfigFieldBase {
    /** The `node.data` key this control edits. */
    key: string;
    label: string;
    /** Helper text under the control. */
    description?: string;
    /*
     * No `defaultValue` here, matching the server: a base member intersects with
     * the arm's, so one typed `string | number` would make `textList`'s
     * `string[]` default uninhabitable. Each arm owns its own.
     */
}

/**
 * One editable config field, ordered as the inspector should render it.
 *
 * Discriminated on `control` exactly as the server declares it, so each widget
 * carries only its own options — narrowing on `control` gives the inspector the
 * right extras and nothing else.
 */
export type BlockConfigField =
    | (BlockConfigFieldBase & { control: 'rolePicker'; defaultValue?: string })
    | (BlockConfigFieldBase & { control: 'channelPicker'; defaultValue?: string })
    | (BlockConfigFieldBase & {
          control: 'text';
          /** Clearing the box removes the key entirely rather than writing `''`. */
          optional?: boolean;
          placeholder?: string;
          maxLength?: number;
          defaultValue?: string;
          /**
           * This field is authored copy: `{{subject.mention}}` and friends are
           * expanded when the flow runs, so the stored text is a template and the
           * value a member sees can be longer than what was typed.
           */
          rendersTokens?: boolean;
      })
    | (BlockConfigFieldBase & {
          control: 'longText';
          placeholder?: string;
          maxLength?: number;
          defaultValue?: string;
          /** See the `text` arm — this field's value is a copy template. */
          rendersTokens?: boolean;
      })
    | (BlockConfigFieldBase & {
          /** Clearing the number removes the key entirely rather than writing a zero. */
          control: 'duration';
          optional?: boolean;
          /** Hint shown in the empty number input — what an absent duration means. */
          placeholder?: string;
          defaultValue?: number;
      })
    | (BlockConfigFieldBase & {
          control: 'segmented';
          options: BlockConfigOption[];
          defaultValue?: string;
      })
    | (BlockConfigFieldBase & {
          control: 'select';
          options: BlockConfigOption[];
          defaultValue?: string;
      })
    | (BlockConfigFieldBase & {
          control: 'colour';
          swatches?: string[];
          defaultValue?: string;
      })
    | (BlockConfigFieldBase & {
          /**
           * An ordered list of short strings the author types. The first control
           * here whose value is not a scalar, which is why `defaultValue` widens
           * on this arm alone.
           */
          control: 'textList';
          /** Hint shown in an empty row. */
          placeholder?: string;
          /** Maximum characters of one entry. */
          maxLength?: number;
          /** Fewest entries the block can work with; below it the author is told. */
          minEntries?: number;
          /** Most entries the block can work with. "Add" stops being offered here. */
          maxEntries?: number;
          /** Label for the button that appends a row. */
          addLabel?: string;
          defaultValue?: string[];
      })
    | (BlockConfigFieldBase & {
          /**
           * An ordered list of records, each holding the same declared columns —
           * `textList` one dimension up.
           */
          control: 'objectList';
          /** The columns every entry carries, in the order a row renders them. */
          columns: BlockConfigColumn[];
          /** Fewest entries the block can work with; below it the author is told. */
          minEntries?: number;
          /** Most entries the block can work with. "Add" stops being offered here. */
          maxEntries?: number;
          /** Label for the button that appends a row. */
          addLabel?: string;
          defaultValue?: Record<string, unknown>[];
      })
    | (BlockConfigFieldBase & {
          /**
           * Who may do this: a principal picker plus whatever that principal
           * needs, as one control over one object-valued key.
           *
           * Declares no options — the principals and the offered permissions are
           * closed vocabularies the control reads from the constants above, so a
           * block re-declaring them would be a second list to keep in step.
           */
          control: 'eligibility';
          defaultValue?: Eligibility;
      });

/**
 * One piece of the one-line config summary on a node's canvas card.
 *
 * Parts are concatenated with **no** implicit separator — a part wanting `" · "`
 * before it writes that into its own `prefix`, because blocks join differently
 * (`#general · "hi"` vs `🌶️ in #rules` vs `Is it #rules?`).
 *
 * Either `key` or `text`, never both. A `key` names a `configFields` entry whose
 * value the browser resolves using that field's own `control`: a picker becomes
 * `@name`/`#name`, a `duration` becomes `5m`, and a `segmented`/`select` becomes
 * the matching option's `label` rather than the raw stored value.
 */
export type BlockCardSummaryPart =
    | {
          key: string;
          text?: undefined;
          /** Literal text immediately before the resolved value, when it renders. */
          prefix?: string;
          /** Literal text immediately after the resolved value, when it renders. */
          suffix?: string;
          /** Wrap the resolved value in double quotes, e.g. a message body. */
          quote?: boolean;
          /** Maximum characters of the resolved value before an ellipsis. */
          truncate?: number;
          /** Shown in place of the value when unset, still inside `prefix`/`suffix`. */
          emptyText?: string;
          /** Drop this part entirely when the field is unset, rather than showing `emptyText`. */
          hideWhenEmpty?: boolean;
          /** When unset, render only this part's `emptyText` as the entire summary. */
          stopIfEmpty?: boolean;
      }
    | {
          key?: undefined;
          text: string;
      };

/** Meaning of an output handle. The builder maps a tone to a colour. */
export const BLOCK_HANDLE_TONES = ['neutral', 'positive', 'negative', 'caution'] as const;

export type BlockHandleTone = (typeof BLOCK_HANDLE_TONES)[number];

/** One way a run can leave a block. */
export interface BlockOutputHandle {
    /** Omitted for the default, unnamed outgoing edge. */
    id?: string;
    label: string;
    tone: BlockHandleTone;
}

/**
 * A value a block writes for later blocks to read, as `{{var.<name>}}`.
 *
 * Discriminated on `naming` because a block does not always know the name it
 * writes: `fixed` carries the name itself, while `authored` says which config
 * field the author types it into. Resolving an `authored` output needs the node's
 * data as well as its descriptor — see `resolveOutputName` in `flows/variables.ts`.
 * Reading `fromField` as a variable name would offer an author a token nothing
 * writes.
 */
export type BlockOutputDeclaration =
    | {
          naming: 'fixed';
          /** The reference name this block always writes. */
          key: string;
          label: string;
          description?: string;
      }
    | {
          naming: 'authored';
          /** The `configFields` key whose **value** is the variable name. */
          fromField: string;
          label: string;
          description?: string;
      };

/** What a block needs to be present in the run context. */
export const FLOW_CONTEXT_REQUIREMENTS = ['subject', 'actor', 'channel', 'interaction'] as const;

export type FlowContextRequirement = (typeof FLOW_CONTEXT_REQUIREMENTS)[number];

/** A Discord permission the bot must hold for a block to work. */
export const BLOCK_CAPABILITIES = ['manageRoles', 'sendMessages', 'embedLinks', 'manageChannels'] as const;

export type BlockCapability = (typeof BLOCK_CAPABILITIES)[number];

/**
 * An available block from the engine's registry (`GET /api/nodes`) — everything
 * the builder needs in order to draw it.
 *
 * The server derives this by subtracting `configSchema` and `run` from its own
 * `BlockManifest`, so every other manifest member arrives here. Why it is mirrored
 * by hand, and what holds the mirror honest, is in the file header.
 */
export interface NodeDescriptor {
    /** Stable identifier persisted in every saved graph, e.g. `action.assignRole`. */
    type: string;
    kind: NodeKind;
    /** Short name shown in the palette, on the card, and in the inspector. */
    label: string;
    /** One line explaining what the block does. */
    description: string;
    group: BlockPaletteGroup;
    /** Palette and card glyph. */
    icon: string;
    /**
     * A block-level aside to render under the form. Presentation only.
     *
     * For what is true of the block as a whole — a caveat spanning every field, or
     * the reassurance that a block with no fields is meant to have none.
     */
    note?: string;
    /** Config fields in the order the inspector should show them. */
    configFields: BlockConfigField[];
    /** The one-line config summary on the canvas card. Absent when nothing is worth summarising. */
    cardSummary?: BlockCardSummaryPart[];
    /** Every way a run can leave this block. */
    handles: BlockOutputHandle[];
    /** Values this block writes for later blocks. */
    outputs: BlockOutputDeclaration[];
    /** Run-context this block cannot work without. */
    requires: FlowContextRequirement[];
    /** Discord permissions the bot needs for this block. */
    capabilities: BlockCapability[];
    /** Whether this block may park its run. */
    canSuspend: boolean;
    /**
     * Whether running this block creates a ticket channel.
     *
     * Absent on every block but the one that opens tickets. The builder previews
     * the channel name from it — a fact the block's own `title` field does not
     * decide, since the name comes from the ticket type's template.
     */
    createsChannel?: boolean;
    /** What fires this trigger. Absent on conditions and actions. */
    startedBy?: BlockTriggerSource;
}

/**
 * Every member of {@link NodeDescriptor}, as data the drift test can read.
 *
 * The list and the interface are held together **by the compiler**, in both
 * directions and without parsing anything: `satisfies` rejects a name that is not
 * a member, and {@link NodeDescriptorKeysAreComplete} below rejects a member that
 * is missing from the list. `tsc -b` runs as the first half of `pnpm build:web`, so
 * the two cannot disagree in a build that passes.
 *
 * Exported for `src/web/api/__tests__/nodeDescriptorDrift.test.ts`, which compares
 * it against the fields the bot actually serves. That test runs in the root
 * workspace and imports this array at runtime; it is not typechecked there, which
 * is exactly why the guarantee has to live here.
 */
export const NODE_DESCRIPTOR_KEYS = [
    'type',
    'kind',
    'label',
    'description',
    'group',
    'icon',
    'note',
    'configFields',
    'cardSummary',
    'handles',
    'outputs',
    'requires',
    'capabilities',
    'canSuspend',
    'createsChannel',
    'startedBy',
] as const satisfies readonly (keyof NodeDescriptor)[];

/**
 * Every member of each {@link BlockConfigField} arm, keyed by its control.
 *
 * The top-level descriptor is not the only hand-mirrored shape: `configFields` is a
 * discriminated union whose arms are mirrored member by member, and it is the shape
 * most likely to change next, since the inspector renders from it. A property added
 * to one arm on the server alone is invisible to a check that only compares
 * top-level names — the browser would be sent a value it cannot type.
 *
 * Same mechanism as {@link NODE_DESCRIPTOR_KEYS}, one level down: `satisfies` rejects
 * a name that is not a member of that arm, {@link ConfigFieldKeysAreComplete} rejects
 * a member missing from its list, and the drift test compares the whole table against
 * the server's own union.
 */
export const BLOCK_CONFIG_FIELD_KEYS = {
    rolePicker: ['key', 'label', 'description', 'control', 'defaultValue'],
    channelPicker: ['key', 'label', 'description', 'control', 'defaultValue'],
    text: ['key', 'label', 'description', 'control', 'optional', 'placeholder', 'maxLength', 'defaultValue', 'rendersTokens'],
    longText: ['key', 'label', 'description', 'control', 'placeholder', 'maxLength', 'defaultValue', 'rendersTokens'],
    duration: ['key', 'label', 'description', 'control', 'optional', 'placeholder', 'defaultValue'],
    segmented: ['key', 'label', 'description', 'control', 'options', 'defaultValue'],
    select: ['key', 'label', 'description', 'control', 'options', 'defaultValue'],
    colour: ['key', 'label', 'description', 'control', 'swatches', 'defaultValue'],
    textList: ['key', 'label', 'description', 'control', 'placeholder', 'maxLength', 'minEntries', 'maxEntries', 'addLabel', 'defaultValue'],
    objectList: ['key', 'label', 'description', 'control', 'columns', 'minEntries', 'maxEntries', 'addLabel', 'defaultValue'],
    eligibility: ['key', 'label', 'description', 'control', 'defaultValue'],
} as const satisfies { [TControl in BlockControlType]: readonly (keyof Extract<BlockConfigField, { control: TControl }>)[] };

/**
 * Every member of {@link BlockConfigColumn}, for the drift gate.
 *
 * A column is the second hand-mirrored interface across this boundary and needs
 * its own list for the same reason the field arms do: `BLOCK_CONFIG_FIELD_KEYS`
 * records that an `objectList` has `columns`, not what one column holds. Without
 * this, a member added to a column on the server alone is served and silently
 * unread — `rendersTokens` is the one that bites, since the engine would expand
 * tokens the inspector renders as literal braces.
 */
export const BLOCK_CONFIG_COLUMN_KEYS = [
    'key',
    'label',
    'control',
    'placeholder',
    'maxLength',
    'rendersTokens',
] as const satisfies readonly (keyof BlockConfigColumn)[];

/** Fails to compile if {@link BlockConfigColumn} gains a member absent above. */
type ConfigColumnKeysAreComplete = Exclude<
    keyof BlockConfigColumn,
    (typeof BLOCK_CONFIG_COLUMN_KEYS)[number]
>;

/** Do not delete as unused: removing it erases the guard above. */
const configColumnKeysAreComplete: [ConfigColumnKeysAreComplete] extends [never]
    ? true
    : ['BLOCK_CONFIG_COLUMN_KEYS is missing', ConfigColumnKeysAreComplete] = true;

void configColumnKeysAreComplete;

/**
 * Fails to compile if any {@link BlockConfigField} arm gains a member absent from
 * {@link BLOCK_CONFIG_FIELD_KEYS}. `satisfies` above only checks the other direction.
 */
type ConfigFieldKeysAreComplete = {
    [TControl in BlockControlType]: Exclude<
        keyof Extract<BlockConfigField, { control: TControl }>,
        (typeof BLOCK_CONFIG_FIELD_KEYS)[TControl][number]
    >;
}[BlockControlType];

/** Do not delete as unused: removing it erases the guard above. */
const configFieldKeysAreComplete: [ConfigFieldKeysAreComplete] extends [never]
    ? true
    : ['BLOCK_CONFIG_FIELD_KEYS is missing', ConfigFieldKeysAreComplete] = true;

void configFieldKeysAreComplete;

/**
 * Fails to compile if {@link NodeDescriptor} gains a member absent from
 * {@link NODE_DESCRIPTOR_KEYS}. `satisfies` alone only checks the other direction.
 */
type NodeDescriptorKeysAreComplete = Exclude<
    keyof NodeDescriptor,
    (typeof NODE_DESCRIPTOR_KEYS)[number]
> extends never
    ? true
    : ['NODE_DESCRIPTOR_KEYS is missing', Exclude<keyof NodeDescriptor, (typeof NODE_DESCRIPTOR_KEYS)[number]>];

/** Do not delete as unused: removing it erases the guard above. */
const nodeDescriptorKeysAreComplete: NodeDescriptorKeysAreComplete = true;

void nodeDescriptorKeysAreComplete;

export interface FlowNode {
    id: string;
    type: string;
    position: { x: number; y: number };
    data: Record<string, unknown>;
}

export interface FlowEdge {
    id: string;
    source: string;
    sourceHandle?: string;
    target: string;
    targetHandle?: string;
}

/**
 * The graph-shape version the server's `flowGraph.ts` parses with `z.literal`.
 *
 * Mirrored rather than imported for the same reason the rest of this file is, and
 * checked against the server's own `FLOW_GRAPH_VERSION` by the descriptor drift
 * gate — a bumped version that never reached here would have the builder writing
 * graphs the save endpoint rejects.
 */
export const FLOW_GRAPH_VERSION = 1 as const;

export interface FlowGraph {
    version: typeof FLOW_GRAPH_VERSION;
    nodes: FlowNode[];
    edges: FlowEdge[];
}

/**
 * The journey a flow sits in, as the flows list reports it.
 *
 * Present for every flow that resolves to a journey — including the implicit one a lone
 * flow gets, whose `memberCount` is 1. **The page must key its grouping on
 * `memberCount > 1`, not on this being non-null**: a journey of one is the state almost
 * every flow with resources is in, and rendering it as a group would put the concept in
 * front of operators who have no use for it.
 */
export interface FlowJourneyMembership {
    journeyKey: string;
    name: string;
    resourceCount: number;
    memberCount: number;
    /**
     * Whether what the journey declares is in the guild, as the list route reports it.
     *
     * Mirrors `JourneyInstallState` in
     * `src/features/provisioning/logic/journeyInstallState.ts`. `partial` is a real state
     * and not a rounding error: a half-finished install, or a resource added to a journey
     * that was already installed.
     *
     * It is derived from the **binding table**, so it says install has run rather than that
     * every channel still exists. The inventory dialog is what checks the latter, and it
     * costs a live Discord plan to do so — which is exactly why this cheaper answer is on
     * the row instead.
     */
    installState: JourneyInstallState;
    /** How many declared resources have a live binding. */
    installedCount: number;
    /**
     * *Which* declared keys have a live binding.
     *
     * Read by the declarations editor, not by the chip: a key with a binding behind it is
     * identity rather than a label, so it must stop following its resource's name — see
     * `web/src/flows/resourceKeyFollowsName.ts`. Carried on the row so the group header and
     * the builder cannot give different answers about the same resource.
     */
    installedKeys: string[];
}

/** See {@link FlowJourneyMembership.installState}. */
export type JourneyInstallState = 'none' | 'partial' | 'all';

/** Row shape in the flows list (no graph — just the summary). */
export interface FlowSummary {
    flowId: string;
    name: string;
    enabled: boolean;
    nodeCount: number;
    journey: FlowJourneyMembership | null;
    createdAt: string;
    updatedAt: string;
}

/** A single flow, graph included. */
export interface Flow {
    flowId: string;
    name: string;
    enabled: boolean;
    graph: FlowGraph;
    createdAt: string;
    updatedAt: string;
}

/** One message a deploy posted. A flow gets one per destination channel. */
export interface DeployedButtonMessage {
    channelId: string;
    messageId: string;
    buttonCount: number;
}

export interface DeployResult {
    ok: true;
    posted: DeployedButtonMessage[];
}

/** A message in the guild carrying this flow's trigger buttons. */
export interface PublishedButtonMessage {
    channelId: string;
    messageId: string;
    nodeIds: string[];
}

/**
 * A channel or role this flow's journey put in the guild.
 *
 * `refused` means unpublishing will leave it alone — it was adopted rather than
 * created, or it is a category still holding something. `explanation` is why, and is
 * the part a dialog must show rather than bury under a count.
 */
/**
 * Why an unpublish refuses to touch a resource.
 *
 * Mirrors `RefusalReason` in `src/features/provisioning/logic/unpublishPlan.ts`.
 * `adopted` and `category-has-survivors` are the two the dialog groups by, and they
 * mean opposite things about ownership: the first was never ours, the second is ours
 * but now has someone else's channel inside it.
 */
export type RefusalReason =
    | 'adopted'
    | 'category-has-survivors'
    | 'missing-permission'
    | 'unrecognised-state';

export interface PublishedResource {
    resourceKey: string;
    kind: string;
    name: string;
    discordId?: string;
    refused: boolean;
    refusalReason?: RefusalReason;
    explanation?: string;
    /** For `category-has-survivors`: what is still inside, by name. */
    survivors?: string[];
}

/**
 * What a flow — or a journey — currently has live in the guild.
 *
 * Mirrors `publishedBody` in `src/web/api/publishedBody.ts`, which is the one wire shape
 * `GET /flows/:flowId/published` and `GET /journeys/:journeyKey/published` both send.
 * One type rather than two, because the two differ only in **scope**, not in shape: a
 * journey's `buttonMessages` covers every attached flow's messages where a flow's covers
 * its own. Everything reading this — `summarisePublished` and both dialogs — cares about
 * the fields, not about which route filled them, so splitting the type would fork that
 * code for no difference it could act on.
 *
 * `mayHaveUnrecordedButtons` is always true and comes from the server rather than
 * being assumed here: buttons posted before the recording table existed had their
 * message ids thrown away, so nothing can find them. An empty list does not mean
 * nothing is published, and the dialog has to say so.
 */
export interface PublishedFlowState {
    buttonMessages: PublishedButtonMessage[];
    deletableResources: PublishedResource[];
    refusedResources: PublishedResource[];
    mayHaveUnrecordedButtons: boolean;
}

export type UndeployOutcome = 'removed' | 'alreadyGone' | 'failed';

export interface UndeployedButtonMessage {
    channelId: string;
    messageId: string;
    outcome: UndeployOutcome;
    explanation?: string;
}

/**
 * What installing would do to one declared resource.
 *
 * Mirrors `PLAN_ACTIONS` in `src/features/provisioning/logic/installPlan.ts`.
 * `blocked` is a first-class outcome rather than an error, because a plan that could
 * only be shown when it is entirely valid would be useless for working out why it
 * is not.
 */
export type InstallPlanAction = 'create' | 'adopt' | 'reuse' | 'blocked';

/** One line of an install plan, as `GET /install-plan` sends it. */
export interface InstallPlanItem {
    resourceKey: string;
    kind: ResourceKind;
    action: InstallPlanAction;
    /** The name the resource will have, or already has. */
    name: string;
    /** Set for `adopt` and `reuse`, and on a `blocked` name collision. */
    discordId?: string;
    /** Why this is blocked, or why a create is replacing something deleted. */
    reason?: string;
}

/**
 * The reviewable plan for installing what a flow declares.
 *
 * `applicable` is the server's own `isPlanApplicable`, on the wire rather than
 * re-derived here: the rule is "no blockers and no blocked item", and a browser
 * re-deriving it would be a second copy to drift. The apply re-checks it server-side
 * regardless, so this is for the UI only.
 */
export interface InstallPlan {
    journeyKey: string;
    applicable: boolean;
    /** Guild-level problems stopping the whole apply — permissions, role hierarchy. */
    blockers: string[];
    items: InstallPlanItem[];
}

/** A resource the install actually put in the guild. */
export interface InstalledResource {
    resourceKey: string;
    discordId: string;
    action: 'created' | 'adopted' | 'reused';
    name: string;
}

/**
 * What an install did.
 *
 * `failure` present alongside a non-empty `applied` is a **partial install**, which is
 * a legitimate state rather than an error: what was created is real and bound, and
 * re-running install continues from there rather than duplicating.
 *
 * `unresolved` names resource keys some node picked that still have no id — deduped
 * resource keys, not one entry per node, because the key is what the operator declared
 * and it is the only thing they can act on.
 */
export interface InstallResult {
    applied: InstalledResource[];
    failure?: string;
    /** Node config values filled in across every flow that picked these resources. */
    writtenCount: number;
    updatedFlowIds: string[];
    unresolved: string[];
    /**
     * The resources were created but writing their ids into flows threw.
     *
     * Its own flag rather than an inference from `writtenCount === 0`, because that
     * count is also zero when there was simply nothing to write. Only this case means
     * the operator's flows are now pointing at nothing.
     */
    writeBackFailed: boolean;
}

export type UnpublishOutcome = 'deleted' | 'forgotten' | 'refused' | 'failed';

export interface UnpublishedResource {
    resourceKey: string;
    kind: string;
    name: string;
    outcome: UnpublishOutcome;
    explanation?: string;
}

/**
 * One way a live object no longer matches what its journey declared.
 *
 * Mirrors `DriftDetailBody` in `src/web/api/driftBody.ts`. `kind` is `string` rather
 * than a union for the same reason `PublishedResource.kind` is: a drift kind this build
 * does not recognise must still show its sentence rather than be dropped, and the
 * sentence is written by the server anyway.
 */
export interface DriftDetail {
    kind: string;
    /** Server-authored prose, in Discord markdown. Render through `withEmphasis`. */
    explanation: string;
}

/**
 * A resource that is still declared, still there, and no longer what it was.
 *
 * Mirrors `DriftResourceBody`. `repairable` comes from the server and is **not**
 * inferred from `drift` — adoption is a property of the binding and appears in no drift
 * kind, so a client deriving it would offer a repair the server refuses.
 */
export interface DriftedResource {
    resourceKey: string;
    name: string;
    kind: string;
    drift: DriftDetail[];
    repairable: boolean;
}

/**
 * A resource the journey installed and no longer declares.
 *
 * Mirrors `OrphanBody`. `stillInGuild` and `neverSettled` come apart in the case that
 * matters — a crash between creating an object and settling its row leaves a
 * never-settled record with a live object behind it — so both travel rather than one
 * being derived from the other.
 */
export interface OrphanedResource {
    bindingId: number;
    resourceKey: string;
    kind: string;
    name: string;
    stillInGuild: boolean;
    neverSettled: boolean;
    /** Server-authored prose, in Discord markdown. Render through `withEmphasis`. */
    explanation: string;
}

/** A resource found, but whose permissions could not be compared, and why. */
export interface UncheckedResource {
    resourceKey: string;
    name: string;
    reason: string;
}

/**
 * The answer to "is my server still what I asked for".
 *
 * Mirrors `DriftBody` in `src/web/api/driftBody.ts`. Drift and orphans arrive together
 * because they are one screen: they are different questions, but an operator asking
 * this one is owed both answers at once.
 *
 * `cleanKeys` is carried so the dialog can say "checked 6, 2 drifted" rather than
 * "2 drifted" — the difference between a report an operator trusts and a number they
 * have to go and verify. `unchecked` is a third state beside clean and drifted, and
 * collapsing it into either is a lie in the direction that costs most.
 */
export interface JourneyDrift {
    journeyKey: string;
    drifted: DriftedResource[];
    cleanKeys: string[];
    unchecked: UncheckedResource[];
    orphans: OrphanedResource[];
}

/**
 * What became of one approved repair.
 *
 * Mirrors `REPAIR_OUTCOMES` in `src/features/provisioning/logic/applyDriftRepair.ts`,
 * and it is **three** values, not four. An earlier version of this mirror added a
 * `partiallyRepaired` member because a comment on the server's catch block names one —
 * the comment describes an intent the code does not implement. A partial repair is
 * `failed` carrying a populated `repaired`; see `RepairedResource.repaired`.
 */
export type RepairOutcome = 'repaired' | 'refused' | 'failed';

export interface RepairedResource {
    resourceKey: string;
    kind: string;
    name: string;
    outcome: RepairOutcome;
    /**
     * Which drift kinds were actually put back.
     *
     * Load-bearing on the `failed` path, not just informational: a resource whose
     * rename landed before a later permission write threw comes back as `failed` with
     * this populated, and it is the **only** signal distinguishing that from a repair
     * that changed nothing. Reporting such a resource as a flat failure tells an
     * operator nothing happened to a channel that really was renamed.
     */
    repaired?: string[];
    explanation?: string;
}

/** What forgetting one leftover record did. */
export interface ForgottenOrphan {
    forgotten: boolean;
    resourceKey: string;
    name: string;
    /**
     * Whether the object is still sitting in the server with nothing tracking it.
     *
     * The distinction an operator is owed: forgetting a record behind a live object
     * means something remains that no screen will mention again.
     */
    objectRemains: boolean;
}

/**
 * One reason a save was refused, addressed to the thing that caused it.
 *
 * Mirrors `FlowValidationIssue` in `src/features/flows/engine/nodeDataValidation.ts`.
 * Both halves are optional and for the same reason they are there: a graph-wide
 * problem blames no node, and an unknown block type blames no field.
 *
 * `field` is a **dotted path** into the node's config — `fields.0.name`, not
 * `fields` — so an issue inside a list entry can be told from one about the list.
 * A control keyed on the whole path therefore matches nothing for those; see
 * `placeIssues` in `web/src/flows/validationIssues.ts` for where they end up.
 */
export interface FlowValidationIssue {
    nodeId?: string;
    field?: string;
    message: string;
}

/**
 * What kind of guild object a declared resource is.
 *
 * Mirrors `RESOURCE_KINDS` on the server. A closed union, because each value has
 * creation code behind it and an unrecognised kind has nothing to fall back on.
 */
export type ResourceKind = 'category' | 'textChannel' | 'role';

export type PermissionAudience = 'everyone' | 'roles' | 'staff' | 'subject';
export type PermissionAccess = 'hidden' | 'readOnly' | 'readWrite';

export interface PermissionIntent {
    audience: PermissionAudience;
    roleIds?: string[];
    access: PermissionAccess;
}

/**
 * A resource a flow needs, named by a key that is stable across guilds.
 *
 * The key is the identity; `defaultName` is only what the operator sees pre-filled.
 * That separation is what lets a picker offer a channel that does not exist yet.
 */
export interface ResourceDeclaration {
    key: string;
    kind: ResourceKind;
    defaultName: string;
    parentKey?: string;
    permissions?: PermissionIntent[];
    description?: string;
    /**
     * A channel or role that already exists, to adopt instead of creating one.
     *
     * Set when the operator picked something real from the resource picker. Absent is
     * the common case and means "create this". Mirrors the server's own
     * `ResourceDeclaration.adoptDiscordId`; the server's Zod schema is the gate.
     */
    adoptDiscordId?: string;
}

/** A journey with its declarations, from `GET /api/guilds/:guildId/journeys/:key`. */
export interface Journey {
    journeyKey: string;
    name: string;
    description: string | null;
    resources: ResourceDeclaration[];
    createdAt: string;
    updatedAt: string;
}

/**
 * A flow attached to a journey.
 *
 * `name` falls back to the flow id when the flow row has vanished — the server never
 * omits a dangling link, because it is still something that blocks a delete.
 */
export interface AttachedFlow {
    flowId: string;
    name: string;
}

/** List shape — no resource bodies, but the attachments each journey holds. */
export interface JourneySummary {
    journeyKey: string;
    name: string;
    description: string | null;
    resourceCount: number;
    attachedFlows: AttachedFlow[];
    createdAt: string;
    updatedAt: string;
}

/** A resource the moving flow brings with it, and what it is in Discord right now. */
export interface MovingResource {
    key: string;
    kind: ResourceKind;
    declaredName: string;
    /** Non-null only for an installed resource — the thing "leave behind" would orphan. */
    live: { discordId: string; name: string } | null;
}

/** A key both journeys declare, and what each of them means by it. */
export interface KeyCollision {
    key: string;
    movingName: string;
    destinationName: string;
}

/**
 * What dropping one flow onto another would do, from `GET /flows/:flowId/group-preview`.
 *
 * The dialog is built entirely from this. `canMerge` false does not close the dialog —
 * leaving the resources behind is still a legitimate choice — it removes the merge
 * option and names the keys that made it impossible.
 */
export interface GroupPreview {
    /** Null when the target has no journey yet, so one would be created. */
    destination: { journeyKey: string; name: string } | null;
    /** What to call the destination in copy, whether or not it exists yet. */
    destinationName: string;
    movingFlowName: string;
    moving: MovingResource[];
    canMerge: boolean;
    collisions: KeyCollision[];
    /** Live resources that "leave behind" would strand. The loud half of the dialog. */
    orphaned: MovingResource[];
}

/** The operator's answer to a group preview. No default — both outcomes are consequential. */
export type GroupResolution = 'merge' | 'leave';

/**
 * The journey one flow installs, from `GET /flows/:flowId/attachment`.
 *
 * `null` for a flow attached to nothing, which is the normal state of a flow that
 * declares no resources. `sharedWith` is every **other** flow on the same journey, which
 * is what makes "detach" read differently from "detach, and two others still install it".
 */
export interface FlowAttachment {
    journeyKey: string;
    name: string;
    resourceCount: number;
    sharedWith: AttachedFlow[];
}

/**
 * What an attach did.
 *
 * `movedFrom` is set when the flow was already on a different journey. A flow has at
 * most one journey — the unique index on `(guildId, flowId)` says so — making attach a
 * **move**, and the UI has to say that rather than implying the flow now has two.
 */
export interface AttachResult {
    journeyKey: string;
    name: string;
    resourceCount: number;
    movedFrom: { journeyKey: string; name: string } | null;
}

/* ---- Tickets ---- */

/**
 * The ticket lifecycle, mirrored from `TICKET_STATUSES` in
 * `src/features/tickets/data/ticketsSchema.ts`.
 *
 * Still a closed union on both sides, unlike the ticket *type* — which stopped being
 * one when types became guild data. Status has code behind each value: the row's
 * category routing and its button enablement both switch on it. Held to the server's
 * copy by `ticketWireShapeDrift.test.ts`.
 */
export const TICKET_STATUSES = ['open', 'closed', 'deleted'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * A person on a ticket, as the row recorded them.
 *
 * Both names are null on a row written before the snapshot columns existed, and the
 * dashboard renders the id then — see `participantLabel`. They are **not** backfilled:
 * doing so would mean fetching every historical member, which is the Discord call the
 * snapshot columns exist to remove.
 */
export interface TicketParticipant {
    id: string;
    username: string | null;
    nickname: string | null;
}

/** A row in the tickets list. */
export interface TicketSummary {
    id: number;
    ticketNumber: number;
    type: string;
    /** Null when the guild no longer declares the type; the raw `type` is shown instead. */
    typeLabel: string | null;
    status: TicketStatus;
    title: string;
    subject: TicketParticipant;
    opener: TicketParticipant | null;
    claimer: TicketParticipant | null;
    channelId: string | null;
    openedAt: string;
    updatedAt: string;
}

/**
 * One ticket in full.
 *
 * There is no `messages` member, deliberately. A ticket stores no conversation — that
 * lives in the Discord channel and is not in the database at all — so the detail page
 * links to the channel instead of pretending to hold its history.
 */
export interface TicketDetail extends TicketSummary {
    reason: string;
    claimedAt: string | null;
    closedAt: string | null;
    deletedAt: string | null;
}

/** A lifecycle response: the updated ticket, plus whether Discord kept up. */
export interface TicketActionResult extends TicketDetail {
    /**
     * Set when the row committed and the channel did not follow.
     *
     * Not an error: the ticket *did* change. On a close it is the sentence saying the
     * subject may still be able to read the channel, which is why it is surfaced rather
     * than logged.
     */
    syncWarning: string | null;
}

/** The three numbers the list's counts strip shows, for the whole guild. */
export interface TicketCounts {
    open: number;
    unclaimed: number;
    closed: number;
}

/** What one role may do on a ticket channel. */
export interface TicketRolePermissions {
    view: boolean;
    send: boolean;
    readHistory: boolean;
    manageMessages: boolean;
}

/** The permission model for one ticket type: the three people a ticket involves. */
export interface TicketPermissionModel {
    subject: TicketRolePermissions;
    opener: TicketRolePermissions;
    staff: TicketRolePermissions;
}

/** One ticket type, as the config editor reads and writes it. */
export interface TicketTypeView {
    type: string;
    label: string;
    nameTemplate: string;
    permissions: TicketPermissionModel;
    autoClaimOnOpen: boolean;
}

/**
 * The ticket config, for the config page.
 *
 * `moderationRoles` carries resolved names beside `moderationRoleIds` so a role renders
 * without a second round trip; a role deleted since it was saved keeps its id and loses
 * its name rather than being quietly dropped from what was saved.
 */
export interface TicketingConfigView {
    configured: boolean;
    deployed: boolean;
    supportTicketCategoryName: string;
    claimedTicketCategoryName: string;
    closedTicketCategoryName: string;
    moderationRoleIds: string[];
    moderationRoles: { id: string; name: string }[];
    types: TicketTypeView[];
}

/*
 * The member lists `ticketWireShapeDrift.test.ts` compares against the server's.
 *
 * Same mechanism as NODE_DESCRIPTOR_KEYS: `satisfies` rejects a name that is not a
 * member, and the checks below reject a member missing from the list, so `tsc -b` holds
 * each list to its interface in both directions. The test then only has to compare two
 * arrays, which means no part of the gate depends on how either file is formatted.
 */
export const TICKET_PARTICIPANT_KEYS = [
    'id',
    'username',
    'nickname',
] as const satisfies readonly (keyof TicketParticipant)[];

export const TICKET_SUMMARY_KEYS = [
    'id',
    'ticketNumber',
    'type',
    'typeLabel',
    'status',
    'title',
    'subject',
    'opener',
    'claimer',
    'channelId',
    'openedAt',
    'updatedAt',
] as const satisfies readonly (keyof TicketSummary)[];

export const TICKET_DETAIL_KEYS = [
    ...TICKET_SUMMARY_KEYS,
    'reason',
    'claimedAt',
    'closedAt',
    'deletedAt',
] as const satisfies readonly (keyof TicketDetail)[];

export const TICKET_ACTION_RESULT_KEYS = [
    ...TICKET_DETAIL_KEYS,
    'syncWarning',
] as const satisfies readonly (keyof TicketActionResult)[];

export const TICKET_COUNTS_KEYS = [
    'open',
    'unclaimed',
    'closed',
] as const satisfies readonly (keyof TicketCounts)[];

export const TICKET_TYPE_VIEW_KEYS = [
    'type',
    'label',
    'nameTemplate',
    'permissions',
    'autoClaimOnOpen',
] as const satisfies readonly (keyof TicketTypeView)[];

/*
 * The shapes *inside* `permissions`, gated separately — see the matching note in
 * `src/web/api/ticketRoutes.ts`.
 *
 * Gating `permissions` by name alone left these four booleans unchecked, and that was
 * proven rather than supposed: a fifth member added server-side and mirrored nowhere left
 * all nine drift tests green. They are the permission bits written onto real Discord
 * channels, and the config page draws one checkbox per member — so an unmirrored member is
 * a permission an operator can never see or set, silently dropped on the next save.
 */
export const TICKET_ROLE_PERMISSIONS_KEYS = [
    'view',
    'send',
    'readHistory',
    'manageMessages',
] as const satisfies readonly (keyof TicketRolePermissions)[];

export const TICKET_PERMISSION_MODEL_KEYS = [
    'subject',
    'opener',
    'staff',
] as const satisfies readonly (keyof TicketPermissionModel)[];

export const TICKETING_CONFIG_VIEW_KEYS = [
    'configured',
    'deployed',
    'supportTicketCategoryName',
    'claimedTicketCategoryName',
    'closedTicketCategoryName',
    'moderationRoleIds',
    'moderationRoles',
    'types',
] as const satisfies readonly (keyof TicketingConfigView)[];

/** Fails to compile if a ticket wire shape gains a member absent from its list above. */
type TicketKeyListsAreComplete =
    | Exclude<keyof TicketParticipant, (typeof TICKET_PARTICIPANT_KEYS)[number]>
    | Exclude<keyof TicketSummary, (typeof TICKET_SUMMARY_KEYS)[number]>
    | Exclude<keyof TicketDetail, (typeof TICKET_DETAIL_KEYS)[number]>
    | Exclude<keyof TicketActionResult, (typeof TICKET_ACTION_RESULT_KEYS)[number]>
    | Exclude<keyof TicketCounts, (typeof TICKET_COUNTS_KEYS)[number]>
    | Exclude<keyof TicketTypeView, (typeof TICKET_TYPE_VIEW_KEYS)[number]>
    | Exclude<keyof TicketRolePermissions, (typeof TICKET_ROLE_PERMISSIONS_KEYS)[number]>
    | Exclude<keyof TicketPermissionModel, (typeof TICKET_PERMISSION_MODEL_KEYS)[number]>
    | Exclude<keyof TicketingConfigView, (typeof TICKETING_CONFIG_VIEW_KEYS)[number]>;

/** Do not delete as unused: removing it erases the guard above. */
const ticketKeyListsAreComplete: [TicketKeyListsAreComplete] extends [never]
    ? true
    : ['A ticket wire-shape key list is missing', TicketKeyListsAreComplete] = true;

void ticketKeyListsAreComplete;

/*
 * The same gate for the drift wire shapes, mirroring `src/web/api/driftBody.ts`.
 *
 * Added after the fact, and the reason is worth keeping: `RepairOutcome` was mirrored
 * here with a fourth member — `partiallyRepaired` — that the server has never emitted.
 * The browser filtered for it, always found nothing, and reported every partial repair
 * as a flat failure, telling operators that nothing happened to channels that really
 * had been renamed. Both workspaces typechecked clean throughout, because each compiles
 * only against its own copy of the shape.
 *
 * `REPAIR_OUTCOMES` is gated as a vocabulary rather than a key list, which is the row
 * that would have caught it.
 */
export const REPAIR_OUTCOMES = ['repaired', 'refused', 'failed'] as const;

export const DRIFT_DETAIL_KEYS = [
    'kind',
    'explanation',
] as const satisfies readonly (keyof DriftDetail)[];

export const DRIFT_RESOURCE_KEYS = [
    'resourceKey',
    'name',
    'kind',
    'drift',
    'repairable',
] as const satisfies readonly (keyof DriftedResource)[];

export const ORPHAN_KEYS = [
    'bindingId',
    'resourceKey',
    'kind',
    'name',
    'stillInGuild',
    'neverSettled',
    'explanation',
] as const satisfies readonly (keyof OrphanedResource)[];

export const UNCHECKED_KEYS = [
    'resourceKey',
    'name',
    'reason',
] as const satisfies readonly (keyof UncheckedResource)[];

export const DRIFT_BODY_KEYS = [
    'journeyKey',
    'drifted',
    'cleanKeys',
    'unchecked',
    'orphans',
] as const satisfies readonly (keyof JourneyDrift)[];

/** Fails to compile if a drift wire shape gains a member absent from its list above. */
type DriftKeyListsAreComplete =
    | Exclude<keyof DriftDetail, (typeof DRIFT_DETAIL_KEYS)[number]>
    | Exclude<keyof DriftedResource, (typeof DRIFT_RESOURCE_KEYS)[number]>
    | Exclude<keyof OrphanedResource, (typeof ORPHAN_KEYS)[number]>
    | Exclude<keyof UncheckedResource, (typeof UNCHECKED_KEYS)[number]>
    | Exclude<keyof JourneyDrift, (typeof DRIFT_BODY_KEYS)[number]>;

/** Do not delete as unused: removing it erases the guard above. */
const driftKeyListsAreComplete: [DriftKeyListsAreComplete] extends [never]
    ? true
    : ['A drift wire-shape key list is missing', DriftKeyListsAreComplete] = true;

void driftKeyListsAreComplete;
