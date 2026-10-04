import { beforeAll, describe, expect, it } from 'vitest';
import {
    BLOCK_CAPABILITIES,
    BLOCK_COLUMN_CONTROLS,
    BLOCK_CONTROL_TYPES,
    BLOCK_HANDLE_TONES,
    BLOCK_KINDS,
    BLOCK_OUTPUT_VALUE_KINDS,
    BLOCK_PALETTE_GROUPS,
    BLOCK_TRIGGER_SOURCES,
    FLOW_CONTEXT_REQUIREMENTS,
} from '../../../features/flows/blocks/manifest';
import type {
    BlockConfigColumn,
    BlockConfigField,
    BlockControlType,
    BlockOutputDeclaration,
    BlockOutputHandle,
    ExitWarningCondition,
    ExitWarningWhenFieldEquals,
    ExitWarningWhenFieldSet,
} from '../../../features/flows/blocks/manifest';
import {
    ELIGIBILITY_PERMISSIONS,
    ELIGIBILITY_PRINCIPALS,
} from '../../../features/flows/engine/eligibility';
import { ensureBlocksDiscovered, listBlockDefinitions } from '../../../features/flows/blocks/registry';
import { FLOW_GRAPH_VERSION } from '../../../features/flows/data/flowGraph';
import { FIELD_CHECK_RULES } from '../../../features/flows/logic/fieldChecks';
import { toDescriptor } from '../nodeRoutes';
import * as browserTypes from '../../../../web/src/api/types';

/**
 * The drift gate between the served node descriptor and the browser's copy of it.
 *
 * `NodeDescriptor` exists twice: once on the server as a subtraction from
 * `BlockManifest` (`../nodeRoutes.ts`) and once as a hand-written interface in
 * `web/src/api/types.ts`. It has to exist twice — a single `import type` from `src/`
 * inside `web/src/` pulls the entire bot source tree into the browser project's
 * compilation and breaks `pnpm build:web` — so this test is what stops the copy
 * rotting, in place of the type system.
 *
 * **The comparison is data, not text.** The browser file exports its own members and
 * vocabularies as `as const` arrays that its *own* `tsc -b` holds to the interface in
 * both directions (see `NODE_DESCRIPTOR_KEYS` there). This test only has to compare
 * those arrays against what the bot really serves, so no part of the gate depends on
 * how either file is formatted.
 *
 * The import below crosses into the web workspace deliberately, and is safe in a way
 * the reverse is not — but not because `tsconfig.json` excludes `web/`. `exclude`
 * only trims the root file set; a file reached by an `import` is compiled regardless,
 * and this one is (`tsc --listFiles` lists it). It is safe because `types.ts` is the
 * leaf of that tree: types and frozen arrays, pulling in no React, no DOM, no
 * `import.meta.env`, and no bot code, so it costs the root program nothing and
 * typechecks cleanly under either config. The reverse direction is what cannot work —
 * `BlockManifest` reaches `discord.js` through `FlowRunContext`, so importing it into
 * the browser drags the server tree into `tsc -b`.
 *
 * The server side is derived **at runtime** from the live registry, so a manifest
 * member that a block actually sets shows up here on its own and this test starts
 * demanding the browser declare it, with no edit to this file.
 */

/** How a maintainer resolves a failure, appended to both directions of the check. */
const REMEDY =
    'Reconcile `web/src/api/types.ts` (the NodeDescriptor interface and NODE_DESCRIPTOR_KEYS) ' +
    'with the served descriptor, or — if the member is genuinely server-only — add it to ' +
    'NON_WIRE_MEMBERS in src/web/api/nodeRoutes.ts so the route withholds it.';

/**
 * Vocabularies that exist independently on both sides, paired with their owners.
 *
 * Field names lining up says nothing about whether a widened union reached the
 * browser — a new control type would leave the inspector unable to type a field it
 * is being sent. Table-driven so extending a vocabulary on one side alone fails
 * here naming it.
 */
const VOCABULARIES = [
    { name: 'NodeKind / BLOCK_KINDS', server: BLOCK_KINDS, browser: browserTypes.NODE_KINDS },
    { name: 'BlockPaletteGroup', server: BLOCK_PALETTE_GROUPS, browser: browserTypes.BLOCK_PALETTE_GROUPS },
    { name: 'BlockTriggerSource', server: BLOCK_TRIGGER_SOURCES, browser: browserTypes.BLOCK_TRIGGER_SOURCES },
    { name: 'BlockControlType', server: BLOCK_CONTROL_TYPES, browser: browserTypes.BLOCK_CONTROL_TYPES },
    // A vocabulary of its own rather than a subset of the one above: a column is
    // not a field and cannot ask for a picker. Gated here because the inspector
    // switches on it, so a member on one side alone is a column it cannot draw.
    {
        name: 'BlockColumnControl',
        server: BLOCK_COLUMN_CONTROLS,
        browser: browserTypes.BLOCK_COLUMN_CONTROLS,
    },
    { name: 'BlockHandleTone', server: BLOCK_HANDLE_TONES, browser: browserTypes.BLOCK_HANDLE_TONES },
    // The pickers and `variableSelect` offer a variable by its kind, so a kind on one
    // side alone is a value the browser either never offers or offers to the wrong control.
    {
        name: 'BlockOutputValueKind',
        server: BLOCK_OUTPUT_VALUE_KINDS,
        browser: browserTypes.BLOCK_OUTPUT_VALUE_KINDS,
    },
    { name: 'FlowContextRequirement', server: FLOW_CONTEXT_REQUIREMENTS, browser: browserTypes.FLOW_CONTEXT_REQUIREMENTS },
    { name: 'BlockCapability', server: BLOCK_CAPABILITIES, browser: browserTypes.BLOCK_CAPABILITIES },
    // Derived from each block's schema and evaluated in the browser by a switch over
    // this union, so a rule the server starts serving alone is one the builder skips.
    { name: 'FieldCheckRule', server: FIELD_CHECK_RULES, browser: browserTypes.FIELD_CHECK_RULES },
    // Not served on a descriptor, and here anyway. The eligibility control
    // renders its principal list from these rather than from what the server sends,
    // so the two copies can drift without a single descriptor key changing —
    // which is exactly the drift this file exists to catch, one level down.
    {
        name: 'EligibilityPrincipal',
        server: ELIGIBILITY_PRINCIPALS,
        browser: browserTypes.ELIGIBILITY_PRINCIPALS,
    },
    {
        name: 'EligibilityPermission',
        server: ELIGIBILITY_PERMISSIONS,
        browser: browserTypes.ELIGIBILITY_PERMISSIONS,
    },
] as const satisfies readonly { name: string; server: readonly string[]; browser: readonly string[] }[];

/**
 * Every member of every {@link BlockConfigField} arm, on the server side.
 *
 * Spelled out rather than read off a live block, because an *optional* member is
 * absent from a field that does not use it — `Object.keys` over the shipping blocks
 * would report `maxLength` as server-only the moment no block set one. Each entry is
 * a real config field with every optional populated, so `satisfies` makes the
 * compiler reject a member this fixture invents and the mapped type below rejects
 * one it forgets. This is a third copy of the arms, and the honest claim is narrower
 * than "not hand-maintained": it cannot rot *silently*. `tsc` fails here the moment
 * an arm grows, naming the member — so the copy is maintained under duress rather
 * than by anybody remembering it exists.
 */
const SHOWN = { field: 'f', equals: ['v'] } as const;

const CONFIG_FIELD_FIXTURES = {
    rolePicker: { key: 'k', label: 'l', description: 'd', visibleWhen: SHOWN, control: 'rolePicker', defaultValue: '' },
    channelPicker: { key: 'k', label: 'l', description: 'd', visibleWhen: SHOWN, control: 'channelPicker', optional: true, defaultValue: '' },
    categoryPicker: { key: 'k', label: 'l', description: 'd', visibleWhen: SHOWN, control: 'categoryPicker', defaultValue: '' },
    ticketTypePicker: { key: 'k', label: 'l', description: 'd', visibleWhen: SHOWN, control: 'ticketTypePicker', optional: true, defaultValue: '' },
    text: { key: 'k', label: 'l', description: 'd', visibleWhen: SHOWN, control: 'text', optional: true, placeholder: '', maxLength: 1, defaultValue: '', rendersTokens: true },
    longText: { key: 'k', label: 'l', description: 'd', visibleWhen: SHOWN, control: 'longText', placeholder: '', maxLength: 1, defaultValue: '', rendersTokens: true },
    duration: { key: 'k', label: 'l', description: 'd', visibleWhen: SHOWN, control: 'duration', optional: true, placeholder: 'p', defaultValue: 1 },
    segmented: { key: 'k', label: 'l', description: 'd', visibleWhen: SHOWN, control: 'segmented', options: [], defaultValue: '' },
    select: { key: 'k', label: 'l', description: 'd', visibleWhen: SHOWN, control: 'select', options: [], defaultValue: '' },
    colour: { key: 'k', label: 'l', description: 'd', visibleWhen: SHOWN, control: 'colour', swatches: [], defaultValue: '' },
    textList: { key: 'k', label: 'l', description: 'd', visibleWhen: SHOWN, control: 'textList', placeholder: 'p', maxLength: 1, minEntries: 1, maxEntries: 1, addLabel: 'a', defaultValue: [] },
    objectList: { key: 'k', label: 'l', description: 'd', visibleWhen: SHOWN, control: 'objectList', columns: [], minEntries: 1, maxEntries: 1, addLabel: 'a', defaultValue: [] },
    eligibility: { key: 'k', label: 'l', description: 'd', visibleWhen: SHOWN, control: 'eligibility', defaultValue: { principal: 'anyone' } },
    variableSelect: { key: 'k', label: 'l', description: 'd', visibleWhen: SHOWN, control: 'variableSelect', valueKind: 'time', defaultValue: '' },
} as const satisfies { [TControl in BlockControlType]: Extract<BlockConfigField, { control: TControl }> };

/** Fails to compile if an arm gains a member {@link CONFIG_FIELD_FIXTURES} omits. */
type FixturesAreExhaustive = {
    [TControl in BlockControlType]: Exclude<
        keyof Extract<BlockConfigField, { control: TControl }>,
        keyof (typeof CONFIG_FIELD_FIXTURES)[TControl]
    >;
}[BlockControlType];

/** Do not delete as unused: removing it erases the guard above. */
const fixturesAreExhaustive: [FixturesAreExhaustive] extends [never]
    ? true
    : ['CONFIG_FIELD_FIXTURES is missing', FixturesAreExhaustive] = true;

void fixturesAreExhaustive;

/**
 * One column with every optional populated, for the same reason the field
 * fixtures exist: an optional member is absent from any column that does not use
 * it, so reading the shipped blocks would report `rendersTokens` as server-only
 * the moment no column set one.
 *
 * `satisfies` rejects a member this invents; {@link ColumnFixtureIsExhaustive}
 * rejects one it forgets.
 */
const CONFIG_COLUMN_FIXTURE = {
    key: 'k',
    label: 'l',
    control: 'text',
    placeholder: 'p',
    maxLength: 1,
    rendersTokens: true,
} as const satisfies BlockConfigColumn;

/** Fails to compile if {@link BlockConfigColumn} gains a member the fixture omits. */
type ColumnFixtureIsExhaustive = Exclude<
    keyof BlockConfigColumn,
    keyof typeof CONFIG_COLUMN_FIXTURE
>;

/** Do not delete as unused: removing it erases the guard above. */
const columnFixtureIsExhaustive: [ColumnFixtureIsExhaustive] extends [never]
    ? true
    : ['CONFIG_COLUMN_FIXTURE is missing', ColumnFixtureIsExhaustive] = true;

void columnFixtureIsExhaustive;

/**
 * One exit with every optional populated, for the reason the field fixtures exist:
 * no shipped block need set `warnIfUnconnected`, and a live sample would then report
 * it as nothing the server sends.
 */
const OUTPUT_HANDLE_FIXTURE = {
    id: 'i',
    label: 'l',
    tone: 'neutral',
    warnIfUnconnected: true,
} as const satisfies BlockOutputHandle;

/** Fails to compile if {@link BlockOutputHandle} gains a member the fixture omits. */
type HandleFixtureIsExhaustive = Exclude<keyof BlockOutputHandle, keyof typeof OUTPUT_HANDLE_FIXTURE>;

/** Do not delete as unused: removing it erases the guard above. */
const handleFixtureIsExhaustive: [HandleFixtureIsExhaustive] extends [never]
    ? true
    : ['OUTPUT_HANDLE_FIXTURE is missing', HandleFixtureIsExhaustive] = true;

void handleFixtureIsExhaustive;

/** Each {@link ExitWarningCondition} arm, by the name the browser's key table uses. */
interface ExitWarningConditionArms {
    whenFieldSet: ExitWarningWhenFieldSet;
    whenFieldEquals: ExitWarningWhenFieldEquals;
}

type ExitWarningArm = keyof ExitWarningConditionArms;

/**
 * The object arms of `warnIfUnconnected`, every member populated.
 *
 * The handle fixture above sets the flag to `true`, so it records that the member
 * exists and nothing about what the condition holds; comparing handle keys alone
 * would let a member added to a condition go unmirrored. One fixture per arm, because
 * the arms carry no tag and the union's own `keyof` is empty.
 */
const EXIT_WARNING_CONDITION_FIXTURES = {
    whenFieldSet: { whenFieldSet: 'f' },
    whenFieldEquals: { whenField: 'f', equals: ['v'] },
} as const satisfies { [TArm in ExitWarningArm]: ExitWarningConditionArms[TArm] };

/**
 * Fails to compile if an arm gains a member its fixture omits, or
 * {@link ExitWarningCondition} gains an arm {@link ExitWarningConditionArms} does not name.
 */
type ConditionFixturesAreExhaustive =
    | {
          [TArm in ExitWarningArm]: Exclude<
              keyof ExitWarningConditionArms[TArm],
              keyof (typeof EXIT_WARNING_CONDITION_FIXTURES)[TArm]
          >;
      }[ExitWarningArm]
    | Exclude<ExitWarningCondition, ExitWarningConditionArms[ExitWarningArm]>;

/** Do not delete as unused: removing it erases the guard above. */
const conditionFixturesAreExhaustive: [ConditionFixturesAreExhaustive] extends [never]
    ? true
    : ['EXIT_WARNING_CONDITION_FIXTURES is missing', ConditionFixturesAreExhaustive] = true;

void conditionFixturesAreExhaustive;

/** Each condition arm paired with the members the server declares on it. */
const EXIT_WARNING_CONDITION_ARMS = (Object.keys(EXIT_WARNING_CONDITION_FIXTURES) as ExitWarningArm[]).map((arm) => ({
    arm,
    members: Object.keys(EXIT_WARNING_CONDITION_FIXTURES[arm]),
}));

/**
 * One output per naming arm, every optional populated.
 *
 * Both arms rather than one, because the arms differ in what names the variable and a
 * member could be added to either alone; and fixtures rather than live blocks, because
 * `valueKindFrom` may have no shipped block setting it at all.
 */
const OUTPUT_DECLARATION_FIXTURES = {
    fixed: {
        naming: 'fixed',
        key: 'k',
        label: 'l',
        description: 'd',
        valueKind: 'channel',
        valueKindFrom: { field: 'f', kinds: { v: 'time' } },
        handle: 'h',
    },
    authored: {
        naming: 'authored',
        fromField: 'f',
        label: 'l',
        description: 'd',
        valueKind: 'channel',
        valueKindFrom: { field: 'f', kinds: { v: 'time' } },
        handle: 'h',
    },
} as const satisfies { [TNaming in OutputNaming]: Extract<BlockOutputDeclaration, { naming: TNaming }> };

type OutputNaming = BlockOutputDeclaration['naming'];

/** Fails to compile if either output arm gains a member its fixture omits. */
type OutputFixturesAreExhaustive = {
    [TNaming in OutputNaming]: Exclude<
        keyof Extract<BlockOutputDeclaration, { naming: TNaming }>,
        keyof (typeof OUTPUT_DECLARATION_FIXTURES)[TNaming]
    >;
}[OutputNaming];

/** Do not delete as unused: removing it erases the guard above. */
const outputFixturesAreExhaustive: [OutputFixturesAreExhaustive] extends [never]
    ? true
    : ['OUTPUT_DECLARATION_FIXTURES is missing', OutputFixturesAreExhaustive] = true;

void outputFixturesAreExhaustive;

/** Each naming arm paired with the members the server declares on it. */
const OUTPUT_DECLARATION_ARMS = (Object.keys(OUTPUT_DECLARATION_FIXTURES) as OutputNaming[]).map((naming) => ({
    naming,
    members: Object.keys(OUTPUT_DECLARATION_FIXTURES[naming]),
}));

/** Each arm's control paired with the members the server declares on it. */
const CONFIG_FIELD_ARMS = BLOCK_CONTROL_TYPES.map((control) => ({
    control,
    members: Object.keys(CONFIG_FIELD_FIXTURES[control]),
}));

describe('node descriptor drift between server and browser', () => {
    /** Every key the route actually serves, taken off the live registry. */
    let servedFields: readonly string[];

    beforeAll(async () => {
        // The registry is an async filesystem scan; reading it first raises.
        await ensureBlocksDiscovered();

        const definitions = listBlockDefinitions();
        expect(definitions.length).toBeGreaterThan(0);

        // Unioned across every block, not taken from one: optional members such as
        // `startedBy` are absent from the key list of any block that does not set
        // them, and a single-block sample would call that a server field the browser
        // must not declare.
        //
        // Read off what the route builds, not the manifest: a derived member such as
        // `fieldChecks` is served without any manifest declaring it.
        const keys = new Set<string>();
        for (const definition of definitions) {
            for (const [key, value] of Object.entries(toDescriptor(definition))) {
                if (value !== undefined) keys.add(key);
            }
        }
        servedFields = [...keys].sort();
    });

    it('declares in the browser every field the route serves', () => {
        const declared = new Set<string>(browserTypes.NODE_DESCRIPTOR_KEYS);
        const missing = servedFields.filter((field) => !declared.has(field));

        expect(
            missing,
            `web/src/api/types.ts \`NodeDescriptor\` is missing: ${missing.join(', ')}. ` +
                `GET /api/nodes serves these and the browser does not type them. ${REMEDY}`
        ).toEqual([]);
    });

    it('declares in the browser nothing the route does not serve', () => {
        const served = new Set(servedFields);
        const extra = browserTypes.NODE_DESCRIPTOR_KEYS.filter((member) => !served.has(member));

        expect(
            extra,
            `web/src/api/types.ts \`NodeDescriptor\` declares fields no block serves: ${extra.join(', ')}. ` +
                'Either a manifest member was removed and the browser still expects it, or the name is ' +
                `misspelled. ${REMEDY}`
        ).toEqual([]);

        // An *optional* member the manifest declares but no block sets is
        // served-as-absent and would slip past the check above. Nothing can assert it
        // from here — the root workspace cannot typecheck the browser file — so it is
        // stated rather than implied: at this level the gate covers members some block
        // actually carries. The config-field arms below have no such hole; they are
        // compared against an exhaustive fixture the compiler keeps honest.
    });

    it.each(VOCABULARIES)('keeps the $name vocabulary identical on both sides', ({ name, server, browser }) => {
        const serverValues = [...server].sort();
        const browserValues = [...browser].sort();

        expect(
            browserValues,
            `The ${name} vocabulary has drifted. Server: [${serverValues.join(', ')}]; ` +
                `browser (web/src/api/types.ts): [${browserValues.join(', ')}]. ` +
                'These unions are closed on both sides, so widening one alone leaves the builder ' +
                'unable to type a value it is being sent.'
        ).toEqual(serverValues);
    });

    it.each(CONFIG_FIELD_ARMS)(
        'keeps the $control config-field arm identical on both sides',
        ({ control, members }) => {
            const serverMembers = [...members].sort();
            // Missing entirely rather than merely different: a control added to the
            // server vocabulary alone has no arm here at all, and spreading the
            // absent entry would throw an unreadable `not iterable` in place of the
            // message below.
            const browserArm = browserTypes.BLOCK_CONFIG_FIELD_KEYS[control] as
                | readonly string[]
                | undefined;

            expect(
                browserArm,
                `The \`${control}\` control has no arm in BLOCK_CONFIG_FIELD_KEYS ` +
                    '(`web/src/api/types.ts`). It was added to BLOCK_CONTROL_TYPES on the server ' +
                    'without the browser gaining a BlockConfigField arm to match, so the inspector ' +
                    'has no widget to render a field that asks for it.'
            ).toBeDefined();

            const browserMembers = [...(browserArm ?? [])].sort();

            expect(
                browserMembers,
                `The \`${control}\` arm of BlockConfigField has drifted. Server: ` +
                    `[${serverMembers.join(', ')}]; browser (web/src/api/types.ts): ` +
                    `[${browserMembers.join(', ')}]. The inspector renders a field from these ` +
                    'members, so one the browser does not declare is one it cannot read off a ' +
                    'field it is being sent. Reconcile the BlockConfigField arm in ' +
                    '`web/src/api/types.ts` and its entry in BLOCK_CONFIG_FIELD_KEYS.'
            ).toEqual(serverMembers);
        }
    );

    it('keeps the objectList column shape identical on both sides', () => {
        const serverMembers = Object.keys(CONFIG_COLUMN_FIXTURE).sort();
        const browserMembers = [...browserTypes.BLOCK_CONFIG_COLUMN_KEYS].sort();

        expect(
            browserMembers,
            `BlockConfigColumn has drifted. Server: [${serverMembers.join(', ')}]; browser ` +
                `(web/src/api/types.ts): [${browserMembers.join(', ')}]. A column is the second ` +
                'hand-mirrored interface across this boundary, and the field-arm check above only ' +
                'records that an objectList has `columns`, not what one column holds — so a member ' +
                'missing here is one the inspector is served and cannot read. `rendersTokens` is the ' +
                'one that bites: the engine would expand tokens the control renders as literal braces.'
        ).toEqual(serverMembers);
    });

    it('keeps the output handle shape identical on both sides', () => {
        const serverMembers = Object.keys(OUTPUT_HANDLE_FIXTURE).sort();
        const browserMembers = [...browserTypes.BLOCK_OUTPUT_HANDLE_KEYS].sort();

        expect(
            browserMembers,
            `BlockOutputHandle has drifted. Server: [${serverMembers.join(', ')}]; browser ` +
                `(web/src/api/types.ts): [${browserMembers.join(', ')}]. An exit is served inside ` +
                '`handles`, so the descriptor-level check cannot see its members — one missing here ' +
                'is sent to a builder that never reads it. Reconcile BlockOutputHandle and ' +
                'BLOCK_OUTPUT_HANDLE_KEYS.'
        ).toEqual(serverMembers);
    });

    it('names the same exit-warning condition arms on both sides', () => {
        const serverArms = Object.keys(EXIT_WARNING_CONDITION_FIXTURES).sort();
        const browserArms = Object.keys(browserTypes.EXIT_WARNING_CONDITION_KEYS).sort();

        expect(
            browserArms,
            `ExitWarningCondition's arms have drifted. Server: [${serverArms.join(', ')}]; browser ` +
                `(web/src/api/types.ts): [${browserArms.join(', ')}]. An arm the browser does not know is a ` +
                'condition the builder never evaluates, so the exit is silently never warned about. Reconcile ' +
                'ExitWarningCondition and EXIT_WARNING_CONDITION_KEYS.'
        ).toEqual(serverArms);
    });

    it.each(EXIT_WARNING_CONDITION_ARMS)('keeps the $arm exit-warning condition identical on both sides', ({ arm, members }) => {
        const serverMembers = [...members].sort();
        const browserArm = browserTypes.EXIT_WARNING_CONDITION_KEYS[arm] as readonly string[] | undefined;
        const browserMembers = [...(browserArm ?? [])].sort();

        expect(
            browserMembers,
            `The \`${arm}\` arm of ExitWarningCondition has drifted. Server: [${serverMembers.join(', ')}]; ` +
                `browser (web/src/api/types.ts): [${browserMembers.join(', ')}]. It is the value of an exit's ` +
                '`warnIfUnconnected`, below what the handle check compares, so a member missing here is ' +
                'one the builder never reads when deciding whether to warn. Reconcile ExitWarningCondition ' +
                'and EXIT_WARNING_CONDITION_KEYS.'
        ).toEqual(serverMembers);
    });

    it.each(OUTPUT_DECLARATION_ARMS)(
        'keeps the $naming output-declaration arm identical on both sides',
        ({ naming, members }) => {
            const serverMembers = [...members].sort();
            const browserArm = browserTypes.BLOCK_OUTPUT_DECLARATION_KEYS[naming] as readonly string[] | undefined;

            expect(
                [...(browserArm ?? [])].sort(),
                `The \`${naming}\` arm of BlockOutputDeclaration has drifted. Server: ` +
                    `[${serverMembers.join(', ')}]; browser (web/src/api/types.ts): ` +
                    `[${[...(browserArm ?? [])].sort().join(', ')}]. The builder offers a variable ` +
                    'from these members, so one it does not declare is a name or a kind it cannot ' +
                    'see. Reconcile BlockOutputDeclaration and BLOCK_OUTPUT_DECLARATION_KEYS.'
            ).toEqual(serverMembers);
        }
    );

    /**
     * The graph-shape version, which is declared on both sides for the same reason
     * the descriptor is and has the same failure mode.
     *
     * Not descriptor drift, but it belongs here: this is the file that already holds
     * both sides in one program, and the alternative is a second test importing the
     * same two modules. The failure it prevents is quiet and total — the server
     * parses `version` with `z.literal`, so a bump that never reached the browser
     * leaves the builder writing graphs that every save rejects, with a green suite
     * and no browser-side error to read.
     */
    it('serves the graph version the browser writes', () => {
        expect(
            browserTypes.FLOW_GRAPH_VERSION,
            'FLOW_GRAPH_VERSION disagrees between `src/features/flows/data/flowGraph.ts` ' +
                'and `web/src/api/types.ts`. The save endpoint parses this with `z.literal`, ' +
                'so until they match the builder cannot save at all.'
        ).toBe(FLOW_GRAPH_VERSION);
    });
});
