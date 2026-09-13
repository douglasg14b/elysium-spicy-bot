import type { ZodType } from 'zod';
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
    /**
     * Starting value when a node is dropped onto the canvas. This is *schema
     * input*, not validated output: where the schema also carries a `.default()`,
     * conformance asserts the two agree rather than letting them drift.
     */
    readonly defaultValue?: string | number;
}

/**
 * One editable config field, ordered as the inspector should render it.
 *
 * Discriminated on `control` so each widget carries only its own options — a
 * `select` cannot forget its choices, and a `text` field cannot smuggle in
 * swatches.
 */
export type BlockConfigField =
    | (BlockConfigFieldBase & { readonly control: 'rolePicker'; readonly defaultValue?: string })
    | (BlockConfigFieldBase & { readonly control: 'channelPicker'; readonly defaultValue?: string })
    | (BlockConfigFieldBase & {
          readonly control: 'text';
          readonly placeholder?: string;
          readonly maxLength?: number;
          readonly defaultValue?: string;
      })
    | (BlockConfigFieldBase & {
          readonly control: 'longText';
          readonly placeholder?: string;
          readonly maxLength?: number;
          readonly defaultValue?: string;
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
      });

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
 * `interaction` is the one that can genuinely be absent: a run started by a
 * gateway event has no originating interaction, and neither does any resumed
 * run. That makes it checkable at save time, and `validateAuthoredGraph` does
 * check it — a block needing one on a path that can never carry one is rejected
 * naming the node.
 *
 * `member` is always present, so declaring it is documentation rather than a
 * constraint anything can violate.
 */
export const FLOW_CONTEXT_REQUIREMENTS = ['member', 'interaction'] as const;

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
    /** Run-context this block cannot work without. */
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
