/**
 * Shapes returned by the SpicyBot API. Kept in sync with `src/web/api/*` by hand,
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
export const BLOCK_CAPABILITIES = ['manageRoles', 'sendMessages', 'embedLinks'] as const;

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

/** Row shape in the flows list (no graph — just the summary). */
export interface FlowSummary {
    flowId: string;
    name: string;
    enabled: boolean;
    nodeCount: number;
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

export interface DeployResult {
    ok: true;
    messageId: string;
}
