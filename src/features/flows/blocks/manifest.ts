import type { ZodType } from 'zod';
import type { Eligibility } from '../engine/eligibility';
import type { FlowStepOutcome } from '../engine/stepOutcome';
import type { FlowRunContext } from './types';

/**
 * The block contract: one declaration and one runtime entry point per block,
 * read by both the interpreter and the builder.
 *
 * A block ships as one directory under this tree exporting a `block` manifest.
 * Nothing outside that directory is edited to add it — no registry entry, no
 * barrel line, and no file under `web/src/flows`. Everything the browser needs
 * in order to draw a block (its icon, its blurb, its form, its handles) is
 * declared here, so the two can no longer disagree.
 *
 * The vocabularies below — kinds, palette groups, control types, handle tones,
 * context requirements, capabilities — are **closed unions, and that is the
 * extension point.** A block that needs something they cannot express extends
 * the vocabulary for everyone; it does not special-case around it locally. See
 * `docs/contracts/block-authoring.md`.
 */

/**
 * What sort of thing a block is. Drives palette styling and which gateway
 * dispatchers consider it a starting point — never what its entry point looks
 * like, which is uniform.
 */
export const BLOCK_KINDS = ['trigger', 'condition', 'action'] as const;

export type BlockKind = (typeof BLOCK_KINDS)[number];

/** Palette section a block is offered in. */
export const BLOCK_PALETTE_GROUPS = ['triggers', 'conditions', 'actions'] as const;

export type BlockPaletteGroup = (typeof BLOCK_PALETTE_GROUPS)[number];

/**
 * What makes a trigger fire.
 *
 * A gateway dispatcher asks the registry which trigger its event starts, rather
 * than importing one block's type constant and comparing against it. That is the
 * difference between a dispatcher that works for every block declaring the same
 * source and one that has to be edited each time a trigger is added.
 *
 * `buttonClick` is the interaction case: the button is rendered by the deploy
 * path and arrives back as a component interaction rather than a gateway event.
 */
export const BLOCK_TRIGGER_SOURCES = ['buttonClick', 'memberJoin', 'reactionAdd'] as const;

export type BlockTriggerSource = (typeof BLOCK_TRIGGER_SOURCES)[number];

/**
 * The editor widgets a block may ask for. Each member is implemented once in
 * the builder and reusable by any block, which is what stops the inspector
 * growing a branch per block type.
 *
 * This list is exactly what the current blocks need. The PRD names further
 * controls; they arrive when a block needs them.
 *
 * **`textList` is the first control whose value is not a scalar**, which is why
 * {@link BlockConfigField}'s `defaultValue` is widened on that arm rather than on
 * the shared base. A control that edits a list of *pickable* things — a list of
 * roles, say — is deliberately **not** that control: its items come from a
 * fetched set rather than a keyboard, so it shares nothing with it but the word
 * "list". `eligibility` is where that list arrived, inside a control whose whole
 * value is an object.
 */
export const BLOCK_CONTROL_TYPES = [
    /** Searchable role picker showing each role's own colour. */
    'rolePicker',
    /** Searchable channel picker. */
    'channelPicker',
    /** Single-line text. */
    'text',
    /** Autosizing multi-line text. */
    'longText',
    /** Number plus unit, stored as milliseconds. */
    'duration',
    /** Small fixed set of choices, all visible at once. */
    'segmented',
    /** Longer fixed set of choices, in a dropdown. */
    'select',
    /** Hex colour, with swatches. */
    'colour',
    /** An ordered, author-editable list of short strings. */
    'textList',
    /** Who is allowed: a principal picker, plus whatever that principal needs. */
    'eligibility',
] as const;

export type BlockControlType = (typeof BLOCK_CONTROL_TYPES)[number];

/** One choice offered by a `segmented` or `select` control. */
export interface BlockConfigOption {
    /** The value persisted in `node.data`. Must satisfy the block's schema. */
    readonly value: string;
    readonly label: string;
}

interface BlockConfigFieldBase {
    /**
     * The `node.data` key this control edits.
     *
     * Typed as a plain string rather than `keyof TConfig`: the registry holds
     * manifests whose config type is erased, where `keyof` would collapse to
     * `never`. Correspondence with the schema is a conformance check instead,
     * which also catches the reverse direction — a schema key no field edits.
     */
    readonly key: string;
    readonly label: string;
    /** Helper text under the control. */
    readonly description?: string;
    /*
     * `defaultValue` is deliberately **not** here, though every arm declares one.
     *
     * A base member is intersected with the arm's, so a base typed
     * `string | number` and a `textList` arm typed `readonly string[]` produce
     * `(string | number) & readonly string[]` — a type nothing inhabits, making
     * the arm's default unsettable rather than merely wrong. Each arm owning its
     * own is what lets a control's default be whatever that control's value is.
     *
     * In every arm it means the same thing: the starting value when a node is
     * dropped onto the canvas, as *schema input* rather than validated output.
     * Where the schema also carries a `.default()`, `checkFieldDefault` in
     * `conformance.ts` asserts the two agree rather than letting them drift.
     */
}

/**
 * One editable config field, ordered as the inspector should render it.
 *
 * Discriminated on `control` so each widget carries only its own options — a
 * `select` cannot forget its choices, and a `text` field cannot smuggle in
 * swatches.
 *
 * **`rendersTokens`** appears on the copy-carrying arms and says that this
 * field's value is *authored copy*, in which `{{subject.mention}}` and friends are
 * expanded before `run` receives it. It is declared per field rather than assumed
 * of every string because most string fields are not copy at all — a message id,
 * an emoji, a button label — and expanding tokens in those would turn a stray
 * brace into a failed run. Declaring it is also what lets save-time validation
 * find the copy fields without knowing which block it is looking at, which is the
 * difference between one rule and a branch per block type.
 */
export type BlockConfigField =
    | (BlockConfigFieldBase & { readonly control: 'rolePicker'; readonly defaultValue?: string })
    | (BlockConfigFieldBase & { readonly control: 'channelPicker'; readonly defaultValue?: string })
    | (BlockConfigFieldBase & {
          readonly control: 'text';
          readonly placeholder?: string;
          readonly maxLength?: number;
          readonly defaultValue?: string;
          readonly rendersTokens?: boolean;
      })
    | (BlockConfigFieldBase & {
          readonly control: 'longText';
          readonly placeholder?: string;
          readonly maxLength?: number;
          readonly defaultValue?: string;
          readonly rendersTokens?: boolean;
      })
    | (BlockConfigFieldBase & {
          /** Clearing the number removes the key entirely rather than writing a zero. */
          readonly control: 'duration';
          readonly optional?: boolean;
          /**
           * Hint shown in the empty number input, e.g. `'No limit'`.
           *
           * Worth having on a duration precisely because the control is two widgets:
           * the hint is the only place to say what an empty box means for an
           * `optional` field, where absence is a real setting rather than a blank.
           */
          readonly placeholder?: string;
          readonly defaultValue?: number;
      })
    | (BlockConfigFieldBase & {
          readonly control: 'segmented';
          readonly options: readonly BlockConfigOption[];
          readonly defaultValue?: string;
      })
    | (BlockConfigFieldBase & {
          readonly control: 'select';
          readonly options: readonly BlockConfigOption[];
          readonly defaultValue?: string;
      })
    | (BlockConfigFieldBase & {
          readonly control: 'colour';
          readonly swatches?: readonly string[];
          readonly defaultValue?: string;
      })
    | (BlockConfigFieldBase & {
          readonly control: 'textList';
          /** Hint shown in an empty row, e.g. `'Yes, I agree'`. */
          readonly placeholder?: string;
          /**
           * Maximum characters of **one entry**, not of the list.
           *
           * Held to the schema's element type by `checkFieldMaxLength`, which
           * probes a one-entry list rather than a bare string for exactly this
           * arm — so `maxLength: 80` over `z.array(z.string().max(20))` is a
           * conformance failure rather than a save an author cannot predict.
           */
          readonly maxLength?: number;
          /**
           * Fewest entries the block can work with. Below it the control still
           * saves — the schema is the authority — but the author is told.
           */
          readonly minEntries?: number;
          /**
           * Most entries the block can work with, e.g. Discord's five buttons to a
           * row. The control stops offering "add" here rather than letting an
           * author build a list the block cannot use.
           *
           * Both bounds are held to the schema, and to each other:
           * `checkFieldEntryBounds` rejects a `minEntries` above its `maxEntries`,
           * which would render a control asking for more entries than it will
           * ever offer a way to add.
           */
          readonly maxEntries?: number;
          /** Label for the button that appends a row, e.g. `'Add a choice'`. */
          readonly addLabel?: string;
          readonly defaultValue?: readonly string[];
          /*
           * Deliberately no `rendersTokens`. `isCopyField` in
           * `engine/copyRendering.ts` narrows to the two single-string arms, and
           * both the executor and save-time validation read one string off the
           * narrowed field. Admitting a list would mean expanding and validating
           * per entry in both places; declaring the flag before that exists would
           * be a field claiming an expansion nothing performs.
           */
      })
    | (BlockConfigFieldBase & {
          /**
           * Who may do this — the principal picker and whatever that principal
           * needs, as **one** control over one object-valued key.
           *
           * One control rather than a principal `select` beside a role list and a
           * variable name, because those extras are mutually exclusive and this
           * field vocabulary has no way to say "show this field only when that
           * one is set". Three always-visible fields, two of which are dead for
           * any given choice, is the form that produces graphs holding a role
           * list under a `subject` gate.
           *
           * Deliberately declares **no options**: the principals and the offered
           * Discord permissions are closed vocabularies the control reads from
           * `engine/eligibility.ts` directly. A block re-declaring them would be
           * a second list to keep in step with the schema that validates them.
           */
          readonly control: 'eligibility';
          /**
           * The starting rule. In practice always `{ principal: 'anyone' }`, which
           * is what an ungated block means and what every saved graph predating
           * this control reads as — but declared per field like every other
           * default, so `checkFieldDefault` holds it to the schema's `.default()`.
           */
          readonly defaultValue?: Eligibility;
      });

/**
 * One piece of the one-line config summary shown on a node's canvas card, e.g.
 * `action.assignRole` -> `Assign @Moderator`, `action.sendMessage` ->
 * `#general · "Say something…"`.
 *
 * A card summary is an ordered list of parts, concatenated with **no** implicit
 * separator — a part that wants `" · "` between it and its neighbour writes that
 * into its own `prefix`, because some blocks join on `·` (`sendMessage`) and
 * others join on a word (`reactionAdd`'s `"🌶️ in #rules"`) or nothing at all
 * (`inChannel`'s `"Is it #rules?"`).
 *
 * Either `key` or `text` is set, never both: `key` names a `configFields` entry
 * whose current `node.data` value the browser resolves and formats using that
 * field's own `control` — a `rolePicker`/`channelPicker` value becomes `@name`/
 * `#name`, a `duration` value becomes `5m`, and a `segmented`/`select` value
 * becomes the matching option's `label` rather than the raw stored value (e.g.
 * `action.waitForEvent`'s `eventKind: 'buttonClick'` renders as "They click a
 * flow button", not `buttonClick`) — `text` is a literal, for the words around
 * a value and for a block with no fields at all (`trigger.memberJoin`'s whole
 * summary is one literal part).
 */
export type BlockCardSummaryPart =
    | {
          readonly key: string;
          readonly text?: undefined;
          /** Literal text immediately before the resolved value, when it renders. */
          readonly prefix?: string;
          /** Literal text immediately after the resolved value, when it renders. */
          readonly suffix?: string;
          /** Wrap the resolved value in double quotes, e.g. a message body. */
          readonly quote?: boolean;
          /** Maximum characters of the resolved value before an ellipsis. */
          readonly truncate?: number;
          /**
           * Rendered in place of the resolved value when the field is unset, still
           * inside this part's `prefix` and `suffix` — `prefix: 'Assign '` with
           * `emptyText: 'no role picked'` reads "Assign no role picked", which is
           * why the shipped copy is a lowercase fragment rather than a sentence.
           *
           * `quote` and `truncate` are skipped: empty copy is the contract's words,
           * not the author's own text. Under `stopIfEmpty` it *is* the whole line,
           * decorations and all discarded.
           */
          readonly emptyText?: string;
          /** Drop this part (and its `prefix`/`suffix`) entirely when the field is unset, rather than showing `emptyText`. */
          readonly hideWhenEmpty?: boolean;
          /**
           * When the field is unset, render only this part's `emptyText` as the
           * **entire** summary, discarding every later part. For a block whose
           * later parts only make sense once this one has a value — an unlabelled
           * button has no style worth showing either.
           */
          readonly stopIfEmpty?: boolean;
      }
    | {
          readonly key?: undefined;
          readonly text: string;
      };

/**
 * Meaning of an output handle, rather than its CSS. The builder maps a tone to
 * a colour; the engine stays free of stylesheet vocabulary.
 */
export const BLOCK_HANDLE_TONES = ['neutral', 'positive', 'negative', 'caution'] as const;

export type BlockHandleTone = (typeof BLOCK_HANDLE_TONES)[number];

/**
 * One way a run can leave a block.
 *
 * Every block declares its handles, so neither the builder nor the executor
 * infers them from the type string. A block with one exit declares a single
 * handle with no `id`, matching the unnamed edge the graph already persists.
 */
export interface BlockOutputHandle {
    /** Omitted for the default, unnamed outgoing edge. */
    readonly id?: string;
    readonly label: string;
    readonly tone: BlockHandleTone;
}

/**
 * A value a block writes for later blocks to read.
 *
 * Declared now and unwritten by every current block: blocks have nowhere to
 * write to until run variables land, so the conformance check that a declared
 * output is actually produced is deferred with them.
 */
export interface BlockOutputDeclaration {
    /** Reference name later blocks use. */
    readonly key: string;
    readonly label: string;
    readonly description?: string;
}

/**
 * What a block needs to be present in the run context.
 *
 * Three of the four can genuinely be absent, which is what makes them checkable
 * at save time — `validateAuthoredGraph` rejects a block needing one on a path
 * that can never carry it, naming the node and the requirement:
 *
 * * `interaction` — a run started by a gateway event has none, and neither does
 *   any resumed run, because the token is expired.
 * * `actor` — a resumed run has nobody who caused the step. A gateway trigger
 *   does, so this is unsatisfiable after a park but fine before one.
 * * `channel` — a member join establishes none, so a path reachable only from
 *   one cannot answer a question about where it is.
 *
 * `subject` is always present, so declaring it is documentation rather than a
 * constraint anything can violate. `guild` is deliberately absent: nothing in a
 * graph can violate it either, and unlike `subject` no block has ever wanted to
 * say it — a requirement that cannot fail and nobody declares is noise.
 */
export const FLOW_CONTEXT_REQUIREMENTS = ['subject', 'actor', 'channel', 'interaction'] as const;

export type FlowContextRequirement = (typeof FLOW_CONTEXT_REQUIREMENTS)[number];

/**
 * A Discord permission the bot must hold for a block to work.
 *
 * Declared only. Nothing checks these yet — reading them back to an
 * administrator is the provisioning work of a later milestone, and a block that
 * lies about them is a manifest bug found there rather than a silent failure
 * here.
 */
export const BLOCK_CAPABILITIES = ['manageRoles', 'sendMessages', 'embedLinks'] as const;

export type BlockCapability = (typeof BLOCK_CAPABILITIES)[number];

/**
 * Everything a block declares, plus the single entry point it implements.
 *
 * `TConfig` is the block's **validated** config — what `configSchema` produces
 * and what `run` receives. The schema's input type is deliberately not a second
 * parameter: validity of declared defaults against the schema is proven by
 * parsing them in the conformance suite, which catches a wrong type, an
 * out-of-range value, and disagreement with a schema `.default()` alike.
 *
 * **Every member here except `configSchema` and `run` is served to the browser**
 * by `GET /api/nodes`, so that the builder can draw a node from what this declares
 * rather than from a copy. Adding a member therefore publishes it to every
 * authenticated dashboard user by default. A server-only member must be added to
 * `NON_WIRE_MEMBERS` in `src/web/api/nodeRoutes.ts`, which will not compile until
 * that route withholds it too.
 *
 * The browser mirrors this by hand in `web/src/api/types.ts`, and
 * `src/web/api/__tests__/nodeDescriptorDrift.test.ts` fails when the two disagree —
 * with one exception to carry yourself: it reads what is served off the blocks that
 * exist, so **a new optional member here that no block sets yet is invisible to it.**
 * Mirror an optional member when you add it, not when the first block sets it.
 */
export interface BlockManifest<TConfig = unknown> {
    /** Stable identifier persisted in every saved graph, e.g. `action.assignRole`. */
    readonly type: string;
    readonly kind: BlockKind;
    /** Short name shown in the palette, on the card, and in the inspector. */
    readonly label: string;
    /** One line explaining what the block does, in the product's own voice. */
    readonly description: string;
    readonly group: BlockPaletteGroup;
    /** Palette and card glyph. */
    readonly icon: string;
    /** The authority on `node.data`. Zod validates; the field list only renders. */
    readonly configSchema: ZodType<TConfig>;
    /** Config fields in the order the inspector should show them. */
    readonly configFields: readonly BlockConfigField[];
    /**
     * The one-line config summary the canvas card shows under the label, e.g.
     * `Assign @Moderator` or `#general · "Say something…"`.
     *
     * **Optional** — a block with nothing worth summarising (`trigger.memberJoin`)
     * can omit it, and the card falls back to a generic "Click to configure"
     * rather than an empty line. See {@link BlockCardSummaryPart} for how the
     * pieces render; conformance checks that every `key` here names a real
     * `configFields` entry.
     */
    readonly cardSummary?: readonly BlockCardSummaryPart[];
    /**
     * A block-level aside, rendered under the form.
     *
     * **Presentation only — nothing in the engine reads this.** It is not a
     * constraint, not a warning the executor acts on, and not a substitute for a
     * field `description`, which belongs to one control. This is for what is true
     * of the block as a whole: a caveat spanning every field, or the reassurance
     * that a block with no fields is meant to have none.
     *
     * Prefer a field's own `description` whenever the copy is about one field. A
     * note that would read identically under a single control is a description
     * wearing a disguise.
     */
    readonly note?: string;
    /** Every way a run can leave this block. */
    readonly handles: readonly BlockOutputHandle[];
    /** Values this block writes for later blocks. Empty until run variables exist. */
    readonly outputs: readonly BlockOutputDeclaration[];
    /**
     * Run-context this block cannot work without.
     *
     * **On a trigger this reads the other way round**: a trigger is never reached
     * by an edge, so nothing upstream could fail to satisfy it — what it declares
     * is what its own event *establishes*, and save-time validation reads it as
     * the supply side when deciding whether a downstream block's requirement can
     * be met on that path. A button click establishes an actor, a channel and an
     * interaction; a member join establishes only an actor, which is why a block
     * asking where it is cannot sit on a join-rooted path.
     *
     * One member serving both readings is deliberate rather than overloaded: a
     * second `supplies` array would have to be kept consistent with this one by
     * hand, and the first time they disagreed the validator would be confidently
     * wrong about a real graph.
     */
    readonly requires: readonly FlowContextRequirement[];
    /**
     * What fires this trigger. Set by triggers and by nothing else — a condition
     * or an action is reached by an edge, not by an event.
     *
     * This is what the gateway dispatchers select on, so adding a trigger for an
     * existing source needs no dispatcher edit; adding one for a *new* source
     * extends the vocabulary and writes the dispatcher once, for everyone.
     */
    readonly startedBy?: BlockTriggerSource;
    /** Discord permissions the bot needs for this block. */
    readonly capabilities: readonly BlockCapability[];
    /**
     * Whether `run` may return a `suspend` outcome.
     *
     * The executor does not read this — it simply consumes whatever outcome it is
     * given, which is how it stops naming block types. It exists so suspension is
     * a stated property rather than an accident: conformance holds a block to it,
     * and the builder can tell an author that a block parks their run.
     */
    readonly canSuspend: boolean;
    /**
     * Do this block's one step, and say what should happen next.
     *
     * The single entry point every block implements, whatever its kind. A trigger
     * carries on; a condition carries on naming the handle it chose; an action
     * performs its side effect and carries on; a suspending block returns the
     * parking request it wants. Throwing is also allowed — the executor records
     * it against the node and fails the run — but returning `fail` is the way to
     * report an expected failure with a message worth reading.
     */
    run(config: TConfig, context: FlowRunContext): Promise<FlowStepOutcome> | FlowStepOutcome;
}
