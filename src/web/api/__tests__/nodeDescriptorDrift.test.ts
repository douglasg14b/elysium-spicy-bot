import { beforeAll, describe, expect, it } from 'vitest';
import {
    BLOCK_CAPABILITIES,
    BLOCK_CONTROL_TYPES,
    BLOCK_HANDLE_TONES,
    BLOCK_KINDS,
    BLOCK_PALETTE_GROUPS,
    BLOCK_TRIGGER_SOURCES,
    FLOW_CONTEXT_REQUIREMENTS,
} from '../../../features/flows/blocks/manifest';
import type { BlockConfigField, BlockControlType } from '../../../features/flows/blocks/manifest';
import { ensureBlocksDiscovered, listBlockDefinitions } from '../../../features/flows/blocks/registry';
import { FLOW_GRAPH_VERSION } from '../../../features/flows/data/flowGraph';
import { NON_WIRE_MEMBERS } from '../nodeRoutes';
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
    { name: 'BlockHandleTone', server: BLOCK_HANDLE_TONES, browser: browserTypes.BLOCK_HANDLE_TONES },
    { name: 'FlowContextRequirement', server: FLOW_CONTEXT_REQUIREMENTS, browser: browserTypes.FLOW_CONTEXT_REQUIREMENTS },
    { name: 'BlockCapability', server: BLOCK_CAPABILITIES, browser: browserTypes.BLOCK_CAPABILITIES },
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
const CONFIG_FIELD_FIXTURES = {
    rolePicker: { key: 'k', label: 'l', description: 'd', control: 'rolePicker', defaultValue: '' },
    channelPicker: { key: 'k', label: 'l', description: 'd', control: 'channelPicker', defaultValue: '' },
    text: { key: 'k', label: 'l', description: 'd', control: 'text', placeholder: '', maxLength: 1, defaultValue: '' },
    longText: { key: 'k', label: 'l', description: 'd', control: 'longText', placeholder: '', maxLength: 1, defaultValue: '' },
    duration: { key: 'k', label: 'l', description: 'd', control: 'duration', optional: true, placeholder: 'p', defaultValue: 1 },
    segmented: { key: 'k', label: 'l', description: 'd', control: 'segmented', options: [], defaultValue: '' },
    select: { key: 'k', label: 'l', description: 'd', control: 'select', options: [], defaultValue: '' },
    colour: { key: 'k', label: 'l', description: 'd', control: 'colour', swatches: [], defaultValue: '' },
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
        const keys = new Set<string>();
        for (const definition of definitions) {
            for (const key of Object.keys(definition)) {
                if (!NON_WIRE_MEMBERS.some((member) => member === key)) {
                    keys.add(key);
                }
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
