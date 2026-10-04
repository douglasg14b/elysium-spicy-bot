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

/**
 * The channel kinds the guild directory reports.
 *
 * Mirrors `GUILD_CHANNEL_TYPES` in `src/web/api/guildBody.ts`, and a closed union
 * because every consumer branches on it — a value nobody handled would be a category
 * silently treated as a place to post.
 *
 * Announcement channels are deliberately absent; the server-side note explains why the
 * endpoint is the wrong place to answer "may a flow use this channel?" while three
 * existing sites still answer it differently.
 */
export const GUILD_CHANNEL_TYPES = ['text', 'category'] as const;
export type GuildChannelType = (typeof GUILD_CHANNEL_TYPES)[number];

/**
 * One channel in the guild directory. Mirrors `GuildChannelBody`.
 *
 * `type` is **required on purpose.** The list used to be text channels only, so every
 * consumer could map it straight into "somewhere to post" — and `ChannelPickerControl`
 * did exactly that, under a comment claiming categories were excluded. They were, by a
 * filter two files away on the server. Now that categories are in the list, a required
 * discriminator is what makes each of those call sites a place the compiler points at
 * rather than a bug that surfaces in a live guild after publish.
 */
export interface GuildChannel {
    id: string;
    name: string;
    type: GuildChannelType;
    /** The category this sits in, or null at the top level. Always null for a category. */
    parentId: string | null;
    /** Resolved server-side, so a row describes itself without a second lookup. */
    parentName: string | null;
}

export const GUILD_CHANNEL_KEYS = [
    'id',
    'name',
    'type',
    'parentId',
    'parentName',
] as const satisfies readonly (keyof GuildChannel)[];

export const GUILD_ROLE_KEYS = [
    'id',
    'name',
    'color',
    'position',
] as const satisfies readonly (keyof GuildRole)[];

/** Fails to compile if a guild wire shape gains a member absent from its list above. */
type GuildKeyListsAreComplete =
    | Exclude<keyof GuildChannel, (typeof GUILD_CHANNEL_KEYS)[number]>
    | Exclude<keyof GuildRole, (typeof GUILD_ROLE_KEYS)[number]>;

/** Do not delete as unused: removing it erases the guard above. */
const guildKeyListsAreComplete: [GuildKeyListsAreComplete] extends [never]
    ? true
    : ['A guild wire-shape key list is missing', GuildKeyListsAreComplete] = true;

void guildKeyListsAreComplete;

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
export const BLOCK_TRIGGER_SOURCES = [
    'buttonClick',
    'levelUp',
    'memberJoin',
    'memberLeave',
    'messageSent',
    'reactionAdd',
    'ticketChanged',
] as const;

export type BlockTriggerSource = (typeof BLOCK_TRIGGER_SOURCES)[number];

/** The editor widget a config field asks for. Each is implemented once here. */
export const BLOCK_CONTROL_TYPES = [
    'rolePicker',
    'channelPicker',
    'categoryPicker',
    'ticketTypePicker',
    'text',
    'longText',
    'duration',
    'segmented',
    'select',
    'colour',
    'textList',
    'objectList',
    'eligibility',
    'variableSelect',
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
    /**
     * Show this field only while a sibling `select`/`segmented` holds one of `equals`.
     * Read through `isFieldVisible` in `flows/variables.ts` — a hidden field usually
     * still holds a value, so presence never decides — and every reader skips a hidden
     * field: the inspector, the live checks, the card summary.
     */
    visibleWhen?: { field: string; equals: string[] };
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
    | (BlockConfigFieldBase & {
          control: 'channelPicker';
          /** The pick can be cleared, which removes the key; empty means something to the block. */
          optional?: boolean;
          defaultValue?: string;
      })
    /** A category, by id. No `{{var}}`: no block records a category. */
    | (BlockConfigFieldBase & { control: 'categoryPicker'; defaultValue?: string })
    /**
     * A ticket type, by key, from the guild's own declared list. A stored key the guild
     * no longer declares shows as not available here. No `{{var}}`, no resource sidecar.
     */
    | (BlockConfigFieldBase & {
          control: 'ticketTypePicker';
          /** The pick can be cleared, which removes the key; empty means something to the block. */
          optional?: boolean;
          defaultValue?: string;
      })
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
      })
    | (BlockConfigFieldBase & {
          /**
           * A variable an earlier block records, picked by name. Stores the bare name,
           * never a `{{var.…}}` token, and offers only variables of `valueKind` — or
           * every variable in scope when `valueKind` is absent.
           */
          control: 'variableSelect';
          valueKind?: BlockOutputValueKind;
          defaultValue?: string;
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
    /**
     * Warn while this exit is unconnected — advice, never a save refusal. Opt-in per
     * exit, for the ones whose silent dead end is rarely meant (a forgotten "No record").
     * `{ whenFieldSet }` warns only while that config field holds a value — a "Timed
     * out" on a wait with no time limit cannot fire, so it is not worth a warning.
     * `{ whenField, equals }` warns only while a choice holds one of `equals` — a "No
     * record" some sources only produce in a rare edge case.
     */
    warnIfUnconnected?: true | ExitWarningCondition;
}

/** When an exit's `warnIfUnconnected` applies, if not always. Told apart by their keys. */
export type ExitWarningCondition = ExitWarningWhenFieldSet | ExitWarningWhenFieldEquals;

/** Warn while this config field holds a value: stored or its default, and not hidden. */
export interface ExitWarningWhenFieldSet {
    whenFieldSet: string;
}

/** Warn while this `select`/`segmented` field holds one of `equals`, read as `visibleWhen` reads. */
export interface ExitWarningWhenFieldEquals {
    whenField: string;
    // Readonly, as the server declares it: shared code hands a served manifest's handles
    // straight to browser helpers, and a mutable array here would refuse them.
    equals: readonly string[];
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
export type BlockOutputDeclaration = BlockOutputDeclarationBase &
    (
        | {
              naming: 'fixed';
              /** The reference name this block always writes. */
              key: string;
          }
        | {
              naming: 'authored';
              /** The `configFields` key whose **value** is the variable name. */
              fromField: string;
          }
    );

/**
 * What a value is, for the controls that take a variable of one kind. Absent means
 * copy only. Not every kind has a picker: `channel` is taken by the channel picker,
 * `time` (an ISO-8601 UTC string) by a `variableSelect` field.
 */
export const BLOCK_OUTPUT_VALUE_KINDS = ['channel', 'time'] as const;

export type BlockOutputValueKind = (typeof BLOCK_OUTPUT_VALUE_KINDS)[number];

interface BlockOutputDeclarationBase {
    label: string;
    description?: string;
    /** What the value is, when it is always the same kind. Read via `resolveOutputValueKind`. */
    valueKind?: BlockOutputValueKind;
    /**
     * What the value is, when it depends on a `select`/`segmented` field: `kinds` maps
     * that field's option values to a kind, and an option left out means no kind.
     * Never set alongside `valueKind`.
     */
    valueKindFrom?: { field: string; kinds: Record<string, BlockOutputValueKind> };
    /**
     * The handle a run leaves by when this was written, if only one does. A
     * condition records what it found on the branch where it found it.
     */
    handle?: string;
}

/** What a block needs to be present in the run context. */
export const FLOW_CONTEXT_REQUIREMENTS = ['subject', 'actor', 'channel', 'interaction'] as const;

export type FlowContextRequirement = (typeof FLOW_CONTEXT_REQUIREMENTS)[number];

/** A Discord permission the bot must hold for a block to work. */
export const BLOCK_CAPABILITIES = ['manageRoles', 'sendMessages', 'embedLinks', 'manageChannels', 'kickMembers'] as const;

export type BlockCapability = (typeof BLOCK_CAPABILITIES)[number];

/**
 * The rules a field can be checked against as an author types, mirroring
 * `src/features/flows/logic/fieldChecks.ts`. Each is named for the JSON Schema keyword
 * the server derives it from; `web/src/flows/fieldChecks.ts` evaluates them.
 */
export const FIELD_CHECK_RULES = [
    'required',
    'integer',
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'minItems',
    'maxItems',
] as const;

export type FieldCheckRule = (typeof FIELD_CHECK_RULES)[number];

/** One rule a field's value must meet, already worded by the server. */
export type FieldCheck =
    | { rule: 'required' | 'integer'; message: string }
    | { rule: Exclude<FieldCheckRule, 'required' | 'integer'>; limit: number; message: string };

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
    /**
     * The rules each field can be checked against as the author types, keyed by field.
     *
     * Not declared by the block: the server derives them from its schema, so every
     * block has them without anyone writing them down. A subset of what the server
     * enforces — what it cannot state here, it reports when asked.
     */
    fieldChecks: Record<string, FieldCheck[]>;
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
    'fieldChecks',
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
    rolePicker: ['key', 'label', 'description', 'visibleWhen', 'control', 'defaultValue'],
    channelPicker: ['key', 'label', 'description', 'visibleWhen', 'control', 'optional', 'defaultValue'],
    categoryPicker: ['key', 'label', 'description', 'visibleWhen', 'control', 'defaultValue'],
    ticketTypePicker: ['key', 'label', 'description', 'visibleWhen', 'control', 'optional', 'defaultValue'],
    text: ['key', 'label', 'description', 'visibleWhen', 'control', 'optional', 'placeholder', 'maxLength', 'defaultValue', 'rendersTokens'],
    longText: ['key', 'label', 'description', 'visibleWhen', 'control', 'placeholder', 'maxLength', 'defaultValue', 'rendersTokens'],
    duration: ['key', 'label', 'description', 'visibleWhen', 'control', 'optional', 'placeholder', 'defaultValue'],
    segmented: ['key', 'label', 'description', 'visibleWhen', 'control', 'options', 'defaultValue'],
    select: ['key', 'label', 'description', 'visibleWhen', 'control', 'options', 'defaultValue'],
    colour: ['key', 'label', 'description', 'visibleWhen', 'control', 'swatches', 'defaultValue'],
    textList: ['key', 'label', 'description', 'visibleWhen', 'control', 'placeholder', 'maxLength', 'minEntries', 'maxEntries', 'addLabel', 'defaultValue'],
    objectList: ['key', 'label', 'description', 'visibleWhen', 'control', 'columns', 'minEntries', 'maxEntries', 'addLabel', 'defaultValue'],
    eligibility: ['key', 'label', 'description', 'visibleWhen', 'control', 'defaultValue'],
    variableSelect: ['key', 'label', 'description', 'visibleWhen', 'control', 'valueKind', 'defaultValue'],
} as const satisfies { [TControl in BlockControlType]: readonly (keyof Extract<BlockConfigField, { control: TControl }>)[] };

/**
 * Every member of {@link BlockOutputHandle}, for the drift gate.
 *
 * An exit is served inside `handles`, so the descriptor-level list only records that
 * a block has handles, not what one handle holds. A member added on the server alone
 * — `warnIfUnconnected` is the one that bites — would be sent and never read, so the
 * builder would stay quiet about exactly the exits a block asked it to watch.
 */
export const BLOCK_OUTPUT_HANDLE_KEYS = [
    'id',
    'label',
    'tone',
    'warnIfUnconnected',
] as const satisfies readonly (keyof BlockOutputHandle)[];

/** Fails to compile if {@link BlockOutputHandle} gains a member absent above. */
type OutputHandleKeysAreComplete = Exclude<keyof BlockOutputHandle, (typeof BLOCK_OUTPUT_HANDLE_KEYS)[number]>;

/** Do not delete as unused: removing it erases the guard above. */
const outputHandleKeysAreComplete: [OutputHandleKeysAreComplete] extends [never]
    ? true
    : ['BLOCK_OUTPUT_HANDLE_KEYS is missing', OutputHandleKeysAreComplete] = true;

void outputHandleKeysAreComplete;

/** Each {@link ExitWarningCondition} arm, by the name the drift gate knows it by. */
interface ExitWarningConditionArms {
    whenFieldSet: ExitWarningWhenFieldSet;
    whenFieldEquals: ExitWarningWhenFieldEquals;
}

/**
 * Every member of each {@link ExitWarningCondition} arm, for the drift gate.
 *
 * Held apart from {@link BLOCK_OUTPUT_HANDLE_KEYS} because it sits one level down, as
 * the *value* of `warnIfUnconnected`: a member or an arm added to the condition on the
 * server alone would move no handle key, and the builder would warn on a rule it only
 * half reads. One list per arm, like {@link BLOCK_OUTPUT_DECLARATION_KEYS}: the arms
 * carry no tag, so the union's own `keyof` is empty and says nothing.
 */
export const EXIT_WARNING_CONDITION_KEYS = {
    whenFieldSet: ['whenFieldSet'],
    whenFieldEquals: ['whenField', 'equals'],
} as const satisfies {
    [TArm in keyof ExitWarningConditionArms]: readonly (keyof ExitWarningConditionArms[TArm])[];
};

/**
 * Fails to compile if an {@link ExitWarningCondition} arm gains a member absent above, or
 * the union gains an arm {@link ExitWarningConditionArms} does not name.
 */
type ExitWarningConditionKeysAreComplete =
    | {
          [TArm in keyof ExitWarningConditionArms]: Exclude<
              keyof ExitWarningConditionArms[TArm],
              (typeof EXIT_WARNING_CONDITION_KEYS)[TArm][number]
          >;
      }[keyof ExitWarningConditionArms]
    | Exclude<ExitWarningCondition, ExitWarningConditionArms[keyof ExitWarningConditionArms]>;

/** Do not delete as unused: removing it erases the guard above. */
const exitWarningConditionKeysAreComplete: [ExitWarningConditionKeysAreComplete] extends [never]
    ? true
    : ['EXIT_WARNING_CONDITION_KEYS is missing', ExitWarningConditionKeysAreComplete] = true;

void exitWarningConditionKeysAreComplete;

/**
 * Every member of each {@link BlockOutputDeclaration} arm, keyed by its `naming`.
 *
 * Same reason as {@link BLOCK_OUTPUT_HANDLE_KEYS}, one member over: an output's
 * members are what the builder offers a variable from, so one missing here is a kind
 * the builder cannot see — `valueKindFrom` unread would offer a time variable to
 * nothing, and its absence would be silent.
 */
export const BLOCK_OUTPUT_DECLARATION_KEYS = {
    fixed: ['naming', 'key', 'label', 'description', 'valueKind', 'valueKindFrom', 'handle'],
    authored: ['naming', 'fromField', 'label', 'description', 'valueKind', 'valueKindFrom', 'handle'],
} as const satisfies {
    [TNaming in BlockOutputDeclaration['naming']]: readonly (keyof Extract<BlockOutputDeclaration, { naming: TNaming }>)[];
};

/** Fails to compile if either {@link BlockOutputDeclaration} arm gains a member absent above. */
type OutputDeclarationKeysAreComplete = {
    [TNaming in BlockOutputDeclaration['naming']]: Exclude<
        keyof Extract<BlockOutputDeclaration, { naming: TNaming }>,
        (typeof BLOCK_OUTPUT_DECLARATION_KEYS)[TNaming][number]
    >;
}[BlockOutputDeclaration['naming']];

/** Do not delete as unused: removing it erases the guard above. */
const outputDeclarationKeysAreComplete: [OutputDeclarationKeysAreComplete] extends [never]
    ? true
    : ['BLOCK_OUTPUT_DECLARATION_KEYS is missing', OutputDeclarationKeysAreComplete] = true;

void outputDeclarationKeysAreComplete;

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
    /**
     * How many problems stand between the stored graph and going live. `0` is ready.
     *
     * Anything above it means the flow is **incomplete**: saved, but refused if switched
     * on. A count because the row has room for a chip; the list itself is in the builder.
     */
    issueCount: number;
    journey: FlowJourneyMembership | null;
    createdAt: string;
    updatedAt: string;
}

/**
 * A single flow, graph included — the body of GET, POST and a successful PUT.
 *
 * `issues` describes the **stored** graph: empty when it is ready to go live, the
 * reasons when it is not. A save that the server accepted can still carry some, because
 * a switched-off flow may hold an unfinished graph.
 */
export interface Flow {
    flowId: string;
    name: string;
    enabled: boolean;
    graph: FlowGraph;
    issues: FlowValidationIssue[];
    createdAt: string;
    updatedAt: string;
}

/** Mirrors `FLOW_DETAIL_KEYS` in `src/web/api/flowBody.ts`; `flowWireShapeDrift.test.ts` compares them. */
export const FLOW_DETAIL_KEYS = [
    'flowId',
    'name',
    'enabled',
    'graph',
    'issues',
    'createdAt',
    'updatedAt',
] as const satisfies readonly (keyof Flow)[];

/** Mirrors `FLOW_SUMMARY_KEYS` in `src/web/api/flowBody.ts`. */
export const FLOW_SUMMARY_KEYS = [
    'flowId',
    'name',
    'enabled',
    'nodeCount',
    'issueCount',
    'journey',
    'createdAt',
    'updatedAt',
] as const satisfies readonly (keyof FlowSummary)[];

/**
 * One operator's draft of a flow, without its graph — what the autosave gets back.
 *
 * `mine` is decided by the server, which knows who is signed in. `flowSavedSince` means
 * the flow was saved after this draft was started, so loading it would put back what
 * that save changed. Mirrors `FlowDraftSummaryBody` in `src/web/api/flowBody.ts`.
 */
export interface FlowDraftSummary {
    draftId: number;
    authorId: string;
    /** A snapshot of their username when the draft was last written. */
    authorName: string;
    mine: boolean;
    name: string;
    baseUpdatedAt: string;
    flowSavedSince: boolean;
    createdAt: string;
    updatedAt: string;
}

/**
 * A draft ready to load onto the canvas: its graph, and that graph's readiness issues
 * against the flow's declarations. Mirrors `FlowDraftBody`.
 */
export interface FlowDraft extends FlowDraftSummary {
    graph: FlowGraph;
    issues: FlowValidationIssue[];
}

/** Where a graph save landed. Mirrors `FLOW_SAVE_TARGETS`. */
export const FLOW_SAVE_TARGETS = ['flow', 'draft'] as const;
export type FlowSaveTarget = (typeof FLOW_SAVE_TARGETS)[number];

/**
 * A successful `PUT /flows/:flowId`. Mirrors `FlowSaveBody`.
 *
 * Always the flow as it now stands. `draft` means the flow is live and the graph was
 * incomplete or waiting on its install, so it went to the caller's draft and the flow —
 * graph, name, issues — is untouched. `draft.issues` are the ones the canvas should show;
 * `uninstalled` names the declared resources the graph picks that aren't in the server.
 */
export type FlowSaveResult =
    | (Flow & { savedAs: 'flow' })
    | (Flow & { savedAs: 'draft'; draft: FlowDraft; uninstalled: string[] });

export const FLOW_DRAFT_SUMMARY_KEYS = [
    'draftId',
    'authorId',
    'authorName',
    'mine',
    'name',
    'baseUpdatedAt',
    'flowSavedSince',
    'createdAt',
    'updatedAt',
] as const satisfies readonly (keyof FlowDraftSummary)[];

export const FLOW_DRAFT_KEYS = [
    ...FLOW_DRAFT_SUMMARY_KEYS,
    'graph',
    'issues',
] as const satisfies readonly (keyof FlowDraft)[];

export const FLOW_SAVED_TO_FLOW_KEYS = [
    ...FLOW_DETAIL_KEYS,
    'savedAs',
] as const satisfies readonly (keyof Extract<FlowSaveResult, { savedAs: 'flow' }>)[];

export const FLOW_SAVED_AS_DRAFT_KEYS = [
    ...FLOW_DETAIL_KEYS,
    'savedAs',
    'draft',
    'uninstalled',
] as const satisfies readonly (keyof Extract<FlowSaveResult, { savedAs: 'draft' }>)[];

/** Fails to compile if a flow wire shape gains a member absent from its list above. */
type FlowKeyListsAreComplete =
    | Exclude<keyof Flow, (typeof FLOW_DETAIL_KEYS)[number]>
    | Exclude<keyof FlowSummary, (typeof FLOW_SUMMARY_KEYS)[number]>
    | Exclude<keyof FlowDraftSummary, (typeof FLOW_DRAFT_SUMMARY_KEYS)[number]>
    | Exclude<keyof FlowDraft, (typeof FLOW_DRAFT_KEYS)[number]>
    | Exclude<keyof Extract<FlowSaveResult, { savedAs: 'flow' }>, (typeof FLOW_SAVED_TO_FLOW_KEYS)[number]>
    | Exclude<keyof Extract<FlowSaveResult, { savedAs: 'draft' }>, (typeof FLOW_SAVED_AS_DRAFT_KEYS)[number]>
    // The vocabulary, both ways: a `savedAs` arm the list does not name, or a name no arm has.
    | Exclude<FlowSaveResult['savedAs'], FlowSaveTarget>
    | Exclude<FlowSaveTarget, FlowSaveResult['savedAs']>;

/** Do not delete as unused: removing it erases the guard above. */
const flowKeyListsAreComplete: [FlowKeyListsAreComplete] extends [never]
    ? true
    : ['A flow wire-shape key list is missing', FlowKeyListsAreComplete] = true;
void flowKeyListsAreComplete;

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
export const REFUSAL_REASONS = [
    'adopted',
    'category-has-survivors',
    'missing-permission',
    'unrecognised-state',
    'interrupted-create',
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

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
export const INSTALL_PLAN_ACTIONS = ['create', 'adopt', 'recover', 'reuse', 'blocked'] as const;
export type InstallPlanAction = (typeof INSTALL_PLAN_ACTIONS)[number];

/** One line of an install plan, as `GET /install-plan` sends it. */
export interface InstallPlanItem {
    resourceKey: string;
    kind: ResourceKind;
    action: InstallPlanAction;
    /** The name the resource will have, or already has. */
    name: string;
    /** Set for `adopt`, `recover` and `reuse`, and on a `blocked` name collision. */
    discordId?: string;
    /**
     * Why this is blocked, why a create is replacing something deleted, or what an
     * interrupted install left for a `recover` to record.
     */
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
 * One reason a graph is not ready to go live, addressed to the thing that caused it.
 *
 * Arrives on a stored flow's `issues`, on a draft's, and on two refusals. One is
 * structural: a graph too broken to store at all (400), whose issues blame no node. The
 * other is switching on an incomplete flow (400). An incomplete graph sent to a live flow
 * is not refused: it lands on the sender's draft, whose issues describe it.
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

/** The three places a ticket channel can sit, in the order the page lists them. */
export const TICKET_CATEGORY_SLOTS = ['open', 'claimed', 'closed'] as const;
export type TicketCategorySlot = (typeof TICKET_CATEGORY_SLOTS)[number];

/**
 * One category slot.
 *
 * `name` is the expected name, the one a deleted category is remade as. `liveName` is what
 * Discord calls the bound category now (null when nothing is bound, or it is gone). A slot
 * with a name and no `discordId` is linked to nothing yet, and tickets stop until it is.
 */
export interface TicketCategoryView {
    name: string;
    discordId: string | null;
    provenance: 'created' | 'adopted' | null;
    liveName: string | null;
}

/** What the page sends for one slot: an existing category, a new name, or `null` to leave it. */
export type TicketCategoryChoice = { discordId: string } | { name: string } | null;

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
    /** `null` per slot when nothing has been chosen. */
    categories: Record<TicketCategorySlot, TicketCategoryView | null>;
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

export const TICKET_CATEGORY_VIEW_KEYS = [
    'name',
    'discordId',
    'provenance',
    'liveName',
] as const satisfies readonly (keyof TicketCategoryView)[];

export const TICKET_CATEGORY_SLOT_KEYS = TICKET_CATEGORY_SLOTS;

export const TICKETING_CONFIG_VIEW_KEYS = [
    'configured',
    'deployed',
    'categories',
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
    | Exclude<keyof TicketingConfigView, (typeof TICKETING_CONFIG_VIEW_KEYS)[number]>
    | Exclude<keyof TicketCategoryView, (typeof TICKET_CATEGORY_VIEW_KEYS)[number]>;

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

/* ---- Leveling ---- */

/*
 * The browser's copy of the leveling wire shapes in `src/web/api/levelingRoutes.ts`.
 *
 * Hand-mirrored rather than imported, for the same reason as the ticket block above: one
 * `import type` from `src/` into `web/src/` pulls the whole bot source tree into this
 * project's compilation and breaks `pnpm build:web`. The duplication is therefore
 * necessary, and `src/web/api/__tests__/levelingWireShapeDrift.test.ts` is what keeps it
 * honest — it compares the `*_KEYS` arrays below against the server's, member for member,
 * so a shape that grows on one side alone fails there rather than in production.
 *
 * Nested shapes are mirrored and gated **separately** (`LevelingMember`,
 * `LevelingActivitySummary`, `LevelingActivityBucket`, `LevelingActivityChart`,
 * `LevelingUserMetrics`), not just as a key on their parent: gating `metrics` as one name
 * would leave all fourteen metrics inside it completely unchecked.
 */

/**
 * The period a member's stats are computed over, mirrored from `STATS_PERIODS` in
 * `src/features/leveling/logic/statsPeriod.ts`.
 *
 * Closed on both sides and ordered shortest to longest, because that is the order the
 * period picker offers them. The server parses the `?period=` query against its own copy,
 * so a value only this side knows about comes back silently downgraded to the default.
 */
export const STATS_PERIODS = ['week', 'month', 'year'] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];

/**
 * How recently a member has been active, mirrored from `ACTIVITY_STATUSES` in
 * `src/features/leveling/cards/statsCard/statsCardMetrics.ts`.
 *
 * Gated as a vocabulary rather than a key list: the badge on the member panel switches on
 * it, so a status the server starts emitting and this side does not declare renders as no
 * badge at all.
 */
export const ACTIVITY_STATUSES = ['active', 'quiet', 'dormant', 'none'] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

/** A member as Discord currently knows them, resolved beside their stored progress. */
export interface LevelingMember {
    userId: string;
    displayName: string;
    username: string;
    /** Null when the account has no avatar, so the browser renders its own fallback. */
    avatarUrl: string | null;
    isBot: boolean;
}

/** A row on the leaderboard. */
export interface LevelingRankingRow {
    rank: number;
    userId: string;
    /** Null when the member has left the guild but still holds progress. */
    member: LevelingMember | null;
    level: number;
    totalXp: number;
    messageCount: number;
    reactionCount: number;
    photoUploadCount: number;
    lastActiveAt: string | null;
}

export interface LevelingListResult {
    entries: LevelingRankingRow[];
    totalRankedMembers: number;
    truncated: boolean;
    /** Whether the guild has leveling switched on at all. */
    enabled: boolean;
}

export interface LevelingActivitySummary {
    messageCount: number;
    reactionCount: number;
    photoUploadCount: number;
    voiceSessionCount: number;
    totalXp: number;
    eventCount: number;
}

export interface LevelingActivityBucket {
    activityDate: string;
    messageCount: number;
    reactionCount: number;
    photoUploadCount: number;
    voiceSessionCount: number;
}

export interface LevelingActivityChart {
    granularity: 'daily' | 'weekly';
    buckets: LevelingActivityBucket[];
}

export interface LevelingUserMetrics {
    activityStatus: ActivityStatus;
    lastActiveAt: string | null;
    memberSince: string | null;
    tenureDays: number;
    recentMsgsPerDay: number;
    recentXpPerDay: number;
    allTimeMsgsPerDay: number;
    messageSharePercent: number;
    reactionSharePercent: number;
    voiceSharePercent: number;
    photoRatePercent: number;
    avgMessageLengthRecent: number | null;
    avgXpPerMessageRecent: number | null;
    dailyPeakEvents: number;
}

export interface LevelingUserDetail {
    userId: string;
    member: LevelingMember | null;
    level: number;
    totalXp: number;
    xpWithinLevel: number;
    xpToNextLevel: number;
    xpForCurrentLevelStep: number;
    hasAnyActivity: boolean;
    statsPeriod: StatsPeriod;
    recentPeriodDays: number;
    recentActivity: LevelingActivitySummary;
    totalActivity: LevelingActivitySummary;
    voiceSessionCount: number;
    totalVoiceSeconds: number;
    activityChart: LevelingActivityChart;
    metrics: LevelingUserMetrics;
}

/*
 * The member lists `levelingWireShapeDrift.test.ts` compares against the server's.
 *
 * Same mechanism as the ticket lists above: `satisfies` rejects a name that is not a
 * member, and the check below rejects a member missing from the list, so `tsc -b` holds
 * each list to its interface in both directions and the test only compares two arrays.
 */
export const LEVELING_MEMBER_KEYS = [
    'userId',
    'displayName',
    'username',
    'avatarUrl',
    'isBot',
] as const satisfies readonly (keyof LevelingMember)[];

export const LEVELING_RANKING_ROW_KEYS = [
    'rank',
    'userId',
    'member',
    'level',
    'totalXp',
    'messageCount',
    'reactionCount',
    'photoUploadCount',
    'lastActiveAt',
] as const satisfies readonly (keyof LevelingRankingRow)[];

export const LEVELING_LIST_RESULT_KEYS = [
    'entries',
    'totalRankedMembers',
    'truncated',
    'enabled',
] as const satisfies readonly (keyof LevelingListResult)[];

export const LEVELING_ACTIVITY_SUMMARY_KEYS = [
    'messageCount',
    'reactionCount',
    'photoUploadCount',
    'voiceSessionCount',
    'totalXp',
    'eventCount',
] as const satisfies readonly (keyof LevelingActivitySummary)[];

export const LEVELING_ACTIVITY_BUCKET_KEYS = [
    'activityDate',
    'messageCount',
    'reactionCount',
    'photoUploadCount',
    'voiceSessionCount',
] as const satisfies readonly (keyof LevelingActivityBucket)[];

export const LEVELING_ACTIVITY_CHART_KEYS = [
    'granularity',
    'buckets',
] as const satisfies readonly (keyof LevelingActivityChart)[];

export const LEVELING_USER_METRICS_KEYS = [
    'activityStatus',
    'lastActiveAt',
    'memberSince',
    'tenureDays',
    'recentMsgsPerDay',
    'recentXpPerDay',
    'allTimeMsgsPerDay',
    'messageSharePercent',
    'reactionSharePercent',
    'voiceSharePercent',
    'photoRatePercent',
    'avgMessageLengthRecent',
    'avgXpPerMessageRecent',
    'dailyPeakEvents',
] as const satisfies readonly (keyof LevelingUserMetrics)[];

export const LEVELING_USER_DETAIL_KEYS = [
    'userId',
    'member',
    'level',
    'totalXp',
    'xpWithinLevel',
    'xpToNextLevel',
    'xpForCurrentLevelStep',
    'hasAnyActivity',
    'statsPeriod',
    'recentPeriodDays',
    'recentActivity',
    'totalActivity',
    'voiceSessionCount',
    'totalVoiceSeconds',
    'activityChart',
    'metrics',
] as const satisfies readonly (keyof LevelingUserDetail)[];

/**
 * The cohorts the insights report bands a server into, mirrored from `COHORT_KEYS` in
 * `src/features/leveling/logic/levelingCohorts.ts`.
 *
 * Ordered least to most active, which is the order the chart legend lists them in. Gated as
 * a vocabulary rather than a key list: the legend and the colour scale switch on it, so a
 * cohort the server starts reporting and this side does not declare draws no line at all.
 *
 * `topOnePercent` deliberately overlaps `topQuarter` — it is a spotlight on the tail, not a
 * fifth exclusive band, so summing `memberCount` across cohorts over-counts by design.
 */
export const COHORT_KEYS = ['bottomHalf', 'middle', 'topQuarter', 'topOnePercent'] as const;
export type CohortKey = (typeof COHORT_KEYS)[number];

/** One point on the "how many members ever got this far" curve. */
export interface LevelingLevelReachPoint {
    level: number;
    membersReached: number;
    /** 0–100, share of tracked members. The count beside it is the truth. */
    percentReached: number;
}

export interface LevelingCohortProgressionPoint {
    level: number;
    medianDays: number;
    membersReached: number;
    /** True below the server's thin-cohort threshold: a hint, not a fact. */
    thin: boolean;
}

export interface LevelingCohortSummary {
    cohort: CohortKey;
    memberCount: number;
    medianTotalXp: number;
    medianLevel: number;
    medianActiveDays: number;
    progression: LevelingCohortProgressionPoint[];
}

export interface LevelingXpDistribution {
    typicalXp: number;
    meanXp: number;
    meanToTypicalRatio: number;
    topMemberXp: number;
    deciles: number[];
}

export interface LevelingInsightsBody {
    trackedMembers: number;
    /**
     * The highest level anybody reached. Unclamped, and null when nobody has earned anything.
     *
     * Can exceed the last point on `levelReach`, which stops at the report's tracked ceiling.
     * `levelReachTruncated` says when that has happened, so the page can explain the gap
     * rather than look wrong.
     */
    topLevel: number | null;
    /** True when somebody is above the tracked ceiling, so the reach curve ends early. */
    levelReachTruncated: boolean;
    levelReach: LevelingLevelReachPoint[];
    cohorts: LevelingCohortSummary[];
    /** Null when there is no XP to describe a distribution of. */
    xpDistribution: LevelingXpDistribution | null;
    firstActivityDate: string | null;
    lastActivityDate: string | null;
    /** ISO. When the report was computed, so the page can say how stale it is. */
    computedAt: string;
    /** True when served from the loader's cache rather than computed for this request. */
    cached: boolean;
}

export const LEVELING_LEVEL_REACH_POINT_KEYS = [
    'level',
    'membersReached',
    'percentReached',
] as const satisfies readonly (keyof LevelingLevelReachPoint)[];

export const LEVELING_COHORT_PROGRESSION_POINT_KEYS = [
    'level',
    'medianDays',
    'membersReached',
    'thin',
] as const satisfies readonly (keyof LevelingCohortProgressionPoint)[];

export const LEVELING_COHORT_SUMMARY_KEYS = [
    'cohort',
    'memberCount',
    'medianTotalXp',
    'medianLevel',
    'medianActiveDays',
    'progression',
] as const satisfies readonly (keyof LevelingCohortSummary)[];

export const LEVELING_XP_DISTRIBUTION_KEYS = [
    'typicalXp',
    'meanXp',
    'meanToTypicalRatio',
    'topMemberXp',
    'deciles',
] as const satisfies readonly (keyof LevelingXpDistribution)[];

export const LEVELING_INSIGHTS_BODY_KEYS = [
    'trackedMembers',
    'topLevel',
    'levelReachTruncated',
    'levelReach',
    'cohorts',
    'xpDistribution',
    'firstActivityDate',
    'lastActivityDate',
    'computedAt',
    'cached',
] as const satisfies readonly (keyof LevelingInsightsBody)[];

/** Fails to compile if a leveling wire shape gains a member absent from its list above. */
type LevelingKeyListsAreComplete =
    | Exclude<keyof LevelingMember, (typeof LEVELING_MEMBER_KEYS)[number]>
    | Exclude<keyof LevelingRankingRow, (typeof LEVELING_RANKING_ROW_KEYS)[number]>
    | Exclude<keyof LevelingListResult, (typeof LEVELING_LIST_RESULT_KEYS)[number]>
    | Exclude<keyof LevelingActivitySummary, (typeof LEVELING_ACTIVITY_SUMMARY_KEYS)[number]>
    | Exclude<keyof LevelingActivityBucket, (typeof LEVELING_ACTIVITY_BUCKET_KEYS)[number]>
    | Exclude<keyof LevelingActivityChart, (typeof LEVELING_ACTIVITY_CHART_KEYS)[number]>
    | Exclude<keyof LevelingUserMetrics, (typeof LEVELING_USER_METRICS_KEYS)[number]>
    | Exclude<keyof LevelingUserDetail, (typeof LEVELING_USER_DETAIL_KEYS)[number]>
    | Exclude<keyof LevelingLevelReachPoint, (typeof LEVELING_LEVEL_REACH_POINT_KEYS)[number]>
    | Exclude<
          keyof LevelingCohortProgressionPoint,
          (typeof LEVELING_COHORT_PROGRESSION_POINT_KEYS)[number]
      >
    | Exclude<keyof LevelingCohortSummary, (typeof LEVELING_COHORT_SUMMARY_KEYS)[number]>
    | Exclude<keyof LevelingXpDistribution, (typeof LEVELING_XP_DISTRIBUTION_KEYS)[number]>
    | Exclude<keyof LevelingInsightsBody, (typeof LEVELING_INSIGHTS_BODY_KEYS)[number]>;

/** Do not delete as unused: removing it erases the guard above. */
const levelingKeyListsAreComplete: [LevelingKeyListsAreComplete] extends [never]
    ? true
    : ['A leveling wire-shape key list is missing', LevelingKeyListsAreComplete] = true;

void levelingKeyListsAreComplete;
