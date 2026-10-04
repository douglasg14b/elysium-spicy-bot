import { z } from '@hono/zod-openapi';
import {
    BLOCK_CAPABILITIES,
    BLOCK_COLUMN_CONTROLS,
    BLOCK_HANDLE_TONES,
    BLOCK_KINDS,
    BLOCK_OUTPUT_VALUE_KINDS,
    BLOCK_PALETTE_GROUPS,
    BLOCK_TRIGGER_SOURCES,
    FLOW_CONTEXT_REQUIREMENTS,
    type BlockCardSummaryPart,
    type BlockConfigColumn,
    type BlockConfigField,
    type BlockControlType,
    type BlockOutputDeclaration,
    type BlockOutputHandle,
    type ExitWarningWhenFieldEquals,
    type ExitWarningWhenFieldSet,
} from '../../features/flows/blocks/manifest';
import { ELIGIBILITY_PERMISSIONS, eligibilitySchema, type Eligibility } from '../../features/flows/engine/eligibility';
import type { NodeDescriptor } from './nodeRoutes';
import type { ChecksHold, MismatchedChecks, SchemaMatches } from './openApi';

/**
 * What `GET /api/nodes` serves: every block's descriptor, the manifest minus what stays on
 * the server (`NON_WIRE_MEMBERS` in `nodeRoutes.ts`).
 *
 * The manifest's types (`features/flows/blocks/manifest.ts`) stay the authority; these
 * schemas state them for the spec, and `NodeBodyChecks` at the end holds each object to its
 * type both ways, member by member. So a manifest member added without a line here fails
 * `pnpm test` (`__tests__/nodeBody.test-d.ts`) and root `tsc` — which is what the browser's
 * hand-written mirror and its drift test used to catch.
 *
 * Every schema here is made with `@hono/zod-openapi`'s `z`; the feature's own zod is only
 * reused below a named container (see `FlowGraphSchema` in `flowBody.ts` for why).
 * Arrays are `.readonly()` because the manifest's are, which has no effect on the spec.
 */

const BlockKindSchema = z.enum(BLOCK_KINDS);

/** Named so the palette can read its sections, in order, off the generated enum. */
const BlockPaletteGroupSchema = z.enum(BLOCK_PALETTE_GROUPS).openapi('BlockPaletteGroup');

const BlockTriggerSourceSchema = z.enum(BLOCK_TRIGGER_SOURCES);

const BlockHandleToneSchema = z.enum(BLOCK_HANDLE_TONES).openapi('BlockHandleTone');

const BlockOutputValueKindSchema = z.enum(BLOCK_OUTPUT_VALUE_KINDS).openapi('BlockOutputValueKind');

/** Named so the eligibility control can offer its permissions off the generated enum. */
const EligibilityPermissionSchema = z.enum(ELIGIBILITY_PERMISSIONS).openapi('EligibilityPermission');

/*
 * A gate as a block's `defaultValue` carries it: `eligibilitySchema`, rebuilt arm by arm.
 * Taken out by position; a reordered or retyped arm on the server fails the `Eligibility`
 * check in `NodeBodyChecks` below rather than passing quietly.
 */
const [anyoneGate, subjectGate, actorGate, variableGate, rolesGate, permissionGate] = eligibilitySchema.options;

/**
 * The one arm stated here rather than reused: its permissions go through the named
 * {@link EligibilityPermissionSchema}, so the browser can list them off the generated enum.
 * The list's own rules are the server's (`.min(1)` copied from `permissionGate`); in a
 * response they describe, and refuse nothing.
 */
const PermissionGateSchema = z.object({
    principal: permissionGate.shape.principal,
    permissions: z.array(EligibilityPermissionSchema).min(1),
});

const EligibilitySchema = z
    .discriminatedUnion('principal', [
        z.object(anyoneGate.shape),
        z.object(subjectGate.shape),
        z.object(actorGate.shape),
        z.object(variableGate.shape),
        z.object(rolesGate.shape),
        PermissionGateSchema,
    ])
    .openapi('Eligibility', {
        description: 'Who may do something, by principal. Each principal carries only what it needs.',
    });

const BlockConfigOptionSchema = z
    .object({
        /** The value persisted in `node.data`. */
        value: z.string(),
        label: z.string(),
    })
    .openapi('BlockConfigOption');

const BlockConfigColumnSchema = z
    .object({
        key: z.string(),
        label: z.string(),
        control: z.enum(BLOCK_COLUMN_CONTROLS),
        placeholder: z.string().optional(),
        maxLength: z.number().optional(),
        rendersTokens: z.boolean().optional(),
    })
    .openapi('BlockConfigColumn', {
        description: 'One column of an `objectList` entry: a named input on every row.',
    });

/** When a field is shown: while a sibling holds one of `equals`. */
const VisibleWhenSchema = z.object({ field: z.string(), equals: z.array(z.string()).readonly() });

/** The members every config field carries, whatever its control. */
const fieldBase = {
    key: z.string(),
    label: z.string(),
    description: z.string().optional(),
    visibleWhen: VisibleWhenSchema.optional(),
};

/**
 * One schema per control, keyed by it. `NodeBodyChecks` below holds each to its arm of
 * `BlockConfigField`, and the record's type holds the keys to `BlockControlType`, so a
 * control added to the vocabulary without an arm here fails to compile.
 */
const CONFIG_FIELD_ARMS = {
    rolePicker: z.object({ ...fieldBase, control: z.literal('rolePicker'), defaultValue: z.string().optional() }),
    channelPicker: z.object({
        ...fieldBase,
        control: z.literal('channelPicker'),
        optional: z.boolean().optional(),
        defaultValue: z.string().optional(),
    }),
    text: z.object({
        ...fieldBase,
        control: z.literal('text'),
        optional: z.boolean().optional(),
        placeholder: z.string().optional(),
        maxLength: z.number().optional(),
        defaultValue: z.string().optional(),
        rendersTokens: z.boolean().optional(),
    }),
    longText: z.object({
        ...fieldBase,
        control: z.literal('longText'),
        placeholder: z.string().optional(),
        maxLength: z.number().optional(),
        defaultValue: z.string().optional(),
        rendersTokens: z.boolean().optional(),
    }),
    duration: z.object({
        ...fieldBase,
        control: z.literal('duration'),
        optional: z.boolean().optional(),
        placeholder: z.string().optional(),
        defaultValue: z.number().optional(),
    }),
    segmented: z.object({
        ...fieldBase,
        control: z.literal('segmented'),
        options: z.array(BlockConfigOptionSchema).readonly(),
        defaultValue: z.string().optional(),
    }),
    select: z.object({
        ...fieldBase,
        control: z.literal('select'),
        options: z.array(BlockConfigOptionSchema).readonly(),
        defaultValue: z.string().optional(),
    }),
    colour: z.object({
        ...fieldBase,
        control: z.literal('colour'),
        swatches: z.array(z.string()).readonly().optional(),
        defaultValue: z.string().optional(),
    }),
    textList: z.object({
        ...fieldBase,
        control: z.literal('textList'),
        placeholder: z.string().optional(),
        maxLength: z.number().optional(),
        minEntries: z.number().optional(),
        maxEntries: z.number().optional(),
        addLabel: z.string().optional(),
        defaultValue: z.array(z.string()).readonly().optional(),
    }),
    objectList: z.object({
        ...fieldBase,
        control: z.literal('objectList'),
        columns: z.array(BlockConfigColumnSchema).readonly(),
        minEntries: z.number().optional(),
        maxEntries: z.number().optional(),
        addLabel: z.string().optional(),
        defaultValue: z.array(z.record(z.string(), z.unknown()).readonly()).readonly().optional(),
    }),
    eligibility: z.object({
        ...fieldBase,
        control: z.literal('eligibility'),
        defaultValue: EligibilitySchema.optional(),
    }),
    variableSelect: z.object({
        ...fieldBase,
        control: z.literal('variableSelect'),
        valueKind: BlockOutputValueKindSchema,
        defaultValue: z.string().optional(),
    }),
} satisfies { [Control in BlockControlType]: z.ZodObject };

const BlockConfigFieldSchema = z
    .discriminatedUnion('control', [
        CONFIG_FIELD_ARMS.rolePicker,
        CONFIG_FIELD_ARMS.channelPicker,
        CONFIG_FIELD_ARMS.text,
        CONFIG_FIELD_ARMS.longText,
        CONFIG_FIELD_ARMS.duration,
        CONFIG_FIELD_ARMS.segmented,
        CONFIG_FIELD_ARMS.select,
        CONFIG_FIELD_ARMS.colour,
        CONFIG_FIELD_ARMS.textList,
        CONFIG_FIELD_ARMS.objectList,
        CONFIG_FIELD_ARMS.eligibility,
        CONFIG_FIELD_ARMS.variableSelect,
    ])
    .openapi('BlockConfigField', {
        description: 'One editable config field, in the order the inspector renders it, discriminated on `control`.',
    });

/** A card summary part naming a config field, whose value the browser resolves and decorates. */
const FieldSummaryPartSchema = z.object({
    key: z.string(),
    prefix: z.string().optional(),
    suffix: z.string().optional(),
    quote: z.boolean().optional(),
    truncate: z.number().optional(),
    emptyText: z.string().optional(),
    hideWhenEmpty: z.boolean().optional(),
    stopIfEmpty: z.boolean().optional(),
});

/** A card summary part that is literal text. */
const TextSummaryPartSchema = z.object({ text: z.string() });

/**
 * One piece of a card's summary: a config field's value, or a literal.
 *
 * The manifest also marks each arm's other member absent (`text?: undefined`, `key?:
 * undefined`). Absence has no JSON Schema the generator accepts, so those markers do not
 * travel: the browser tells the arms apart with `'key' in part`. The arm checks below
 * compare everything else member by member.
 */
const BlockCardSummaryPartSchema = z
    .union([FieldSummaryPartSchema, TextSummaryPartSchema])
    .openapi('BlockCardSummaryPart');

/** Warn while this config field holds a value. */
const WhenFieldSetSchema = z.object({ whenFieldSet: z.string() });

/** Warn while this choice holds one of `equals`. */
const WhenFieldEqualsSchema = z.object({ whenField: z.string(), equals: z.array(z.string()).readonly() });

const BlockOutputHandleSchema = z
    .object({
        id: z.string().optional(),
        label: z.string(),
        tone: BlockHandleToneSchema,
        warnIfUnconnected: z.union([z.literal(true), WhenFieldSetSchema, WhenFieldEqualsSchema]).optional(),
    })
    .openapi('BlockOutputHandle', {
        description:
            'One way a run can leave a block. `warnIfUnconnected` is `true`, or the condition under which the ' +
            'builder warns while the exit is unconnected.',
    });

/** An output's kind, when a choice the author makes decides it. */
const ValueKindFromSchema = z.object({
    field: z.string(),
    kinds: z.record(z.string(), BlockOutputValueKindSchema).readonly(),
});

/** The members both naming arms of an output carry. */
const outputBase = {
    label: z.string(),
    description: z.string().optional(),
    valueKind: BlockOutputValueKindSchema.optional(),
    valueKindFrom: ValueKindFromSchema.optional(),
    handle: z.string().optional(),
};

const FixedOutputSchema = z.object({ ...outputBase, naming: z.literal('fixed'), key: z.string() });

const AuthoredOutputSchema = z.object({ ...outputBase, naming: z.literal('authored'), fromField: z.string() });

const BlockOutputDeclarationSchema = z
    .discriminatedUnion('naming', [FixedOutputSchema, AuthoredOutputSchema])
    .openapi('BlockOutputDeclaration', {
        description:
            'A value a block writes for later blocks. `fixed` writes `key`; `authored` writes the name the node ' +
            'holds in its `fromField` config field.',
    });

export const NodeDescriptorSchema = z
    .object({
        type: z.string(),
        kind: BlockKindSchema,
        label: z.string(),
        description: z.string(),
        group: BlockPaletteGroupSchema,
        icon: z.string(),
        configFields: z.array(BlockConfigFieldSchema).readonly(),
        cardSummary: z.array(BlockCardSummaryPartSchema).readonly().optional(),
        note: z.string().optional(),
        handles: z.array(BlockOutputHandleSchema).readonly(),
        outputs: z.array(BlockOutputDeclarationSchema).readonly(),
        requires: z.array(z.enum(FLOW_CONTEXT_REQUIREMENTS)).readonly(),
        startedBy: BlockTriggerSourceSchema.optional(),
        capabilities: z.array(z.enum(BLOCK_CAPABILITIES)).readonly(),
        createsChannel: z.boolean().optional(),
        canSuspend: z.boolean(),
    })
    .openapi('NodeDescriptor', {
        description:
            "Everything the Flow Builder draws a block from: its palette entry, its card, its inspector form and its exits. The block's config schema stays on the server.",
    });

/** Both ways, for a union `SchemaMatches`' member-name half reads nothing off: one with no common member. */
type AssignableBothWays<Schema extends z.ZodType, Domain> = [z.infer<Schema>] extends [Domain]
    ? [Domain] extends [z.infer<Schema>]
        ? true
        : false
    : false;

/**
 * Every schema above against the manifest type it states, `true` where they match.
 *
 * Each object is checked on its own, members and all — every config-field arm, both output
 * arms, both exit-warning forms, the nested `visibleWhen` and `valueKindFrom` — because
 * `SchemaMatches` compares member names one level deep and a union's `keyof` names only
 * what its arms share: an optional member added to one arm would pass a check of the whole.
 * The unions are checked as wholes too, which is what catches an arm added or dropped.
 *
 * The two card-summary arms leave out the manifest's absence markers (`text?: undefined`,
 * `key?: undefined`): absence has no JSON Schema the generator accepts, so they do not
 * travel, and the browser tells the arms apart with `'key' in part`.
 */
type NodeBodyChecks = ChecksHold<{
    [Control in BlockControlType as `configField.${Control}`]: SchemaMatches<
        (typeof CONFIG_FIELD_ARMS)[Control],
        Extract<BlockConfigField, { control: Control }>
    >;
} & {
    NodeDescriptor: SchemaMatches<typeof NodeDescriptorSchema, NodeDescriptor>;
    BlockConfigField: AssignableBothWays<typeof BlockConfigFieldSchema, BlockConfigField>;
    visibleWhen: SchemaMatches<typeof VisibleWhenSchema, NonNullable<BlockConfigField['visibleWhen']>>;
    BlockConfigColumn: SchemaMatches<typeof BlockConfigColumnSchema, BlockConfigColumn>;
    Eligibility: AssignableBothWays<typeof EligibilitySchema, Eligibility>;
    'Eligibility.discordPermission': SchemaMatches<
        typeof PermissionGateSchema,
        Extract<Eligibility, { principal: 'discordPermission' }>
    >;
    BlockCardSummaryPart: AssignableBothWays<typeof BlockCardSummaryPartSchema, BlockCardSummaryPart>;
    'BlockCardSummaryPart.field': SchemaMatches<
        typeof FieldSummaryPartSchema,
        Omit<Extract<BlockCardSummaryPart, { key: string }>, 'text'>
    >;
    'BlockCardSummaryPart.text': SchemaMatches<
        typeof TextSummaryPartSchema,
        Omit<Extract<BlockCardSummaryPart, { text: string }>, 'key'>
    >;
    BlockOutputHandle: SchemaMatches<typeof BlockOutputHandleSchema, BlockOutputHandle>;
    'ExitWarningCondition.whenFieldSet': SchemaMatches<typeof WhenFieldSetSchema, ExitWarningWhenFieldSet>;
    'ExitWarningCondition.whenFieldEquals': SchemaMatches<typeof WhenFieldEqualsSchema, ExitWarningWhenFieldEquals>;
    BlockOutputDeclaration: AssignableBothWays<typeof BlockOutputDeclarationSchema, BlockOutputDeclaration>;
    'BlockOutputDeclaration.fixed': SchemaMatches<
        typeof FixedOutputSchema,
        Extract<BlockOutputDeclaration, { naming: 'fixed' }>
    >;
    'BlockOutputDeclaration.authored': SchemaMatches<
        typeof AuthoredOutputSchema,
        Extract<BlockOutputDeclaration, { naming: 'authored' }>
    >;
    valueKindFrom: SchemaMatches<typeof ValueKindFromSchema, NonNullable<BlockOutputDeclaration['valueKindFrom']>>;
}>;

/**
 * The names of the checks in {@link NodeBodyChecks} that fail, or `never` when the spec states
 * the manifest exactly.
 *
 * Asserted `never` in `__tests__/nodeBody.test-d.ts`, which `pnpm test` type-checks — the
 * suite is where a drifted descriptor fails, as the browser drift test it replaced did.
 * `ChecksHold` says the same to root `tsc`, at the failing check.
 */
export type NodeBodyMismatch = MismatchedChecks<NodeBodyChecks>;
