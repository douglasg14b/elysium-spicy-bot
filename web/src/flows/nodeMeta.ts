/**
 * Presentation helpers shared by the palette, the canvas cards and the inspector.
 * Node *kinds* drive colour (trigger=green, condition=amber, action=brand cyan)
 * per the flow-builder mockup.
 *
 * **Every export here is generic — none of it knows a block type**, and a gate
 * asserts that by pinning this file's export list. That is deliberate: this file
 * used to hold the browser's own copy of the block catalogue (emoji per type,
 * description per type, a twelve-case card summary, hardcoded branch handles), and
 * those copies drifted from the server's manifests because nothing forced them to
 * agree. They are gone; the builder renders from the descriptor the server sends.
 *
 * So: a block's glyph, blurb, exits and card copy are declared in
 * `src/features/flows/blocks/<block>/index.ts` and nowhere else. If you find
 * yourself wanting a `Record<string, …>` keyed by block type in this file, the
 * thing you want belongs on the manifest instead.
 */

import type {
    BlockHandleTone,
    BlockOutputHandle,
    FlowGraph,
    NodeDescriptor,
    NodeKind,
} from '../api/types';
import { FLOW_GRAPH_VERSION } from '../api/types';

export interface KindStyle {
    /** Mantine colour key for badges/icons. */
    color: string;
    /** CSS gradient for the card header, mirroring the mockup. */
    headerGradient: string;
    /** Header text colour — the cyan header wants dark ink, the others white. */
    headerText: string;
    /** Translucent tint for palette icon chips. */
    softBg: string;
    /** Flat hex for the minimap, which cannot take a gradient or a CSS variable. */
    miniMapColor: string;
    label: string;
}

export const KIND_STYLES: Record<NodeKind, KindStyle> = {
    trigger: {
        color: 'green',
        headerGradient: 'linear-gradient(135deg, #3aa876, #43b581)',
        headerText: '#ffffff',
        softBg: 'rgba(67,181,129,.2)',
        miniMapColor: '#43b581',
        label: 'Trigger',
    },
    condition: {
        color: 'yellow',
        headerGradient: 'linear-gradient(135deg, #e0940f, #faa61a)',
        headerText: '#ffffff',
        softBg: 'rgba(250,166,26,.2)',
        miniMapColor: '#faa61a',
        label: 'Condition',
    },
    action: {
        color: 'brand',
        headerGradient:
            'linear-gradient(135deg, var(--mantine-color-brand-7), var(--mantine-color-brand-6))',
        headerText: '#041017',
        softBg: 'rgba(0,162,255,.16)',
        miniMapColor: '#00a2ff',
        label: 'Action',
    },
};

/**
 * A handle's declared tone as a colour, in the two forms the builder draws in.
 *
 * Tone is meaning; the stylesheet lives here, which is why the engine never carries
 * one. Both forms are needed because the two renderers cannot share a value: DOM
 * nodes take a Mantine CSS variable, while React Flow paints edges into SVG
 * `stroke`/`fill`, which cannot resolve one. They are not the same colour in every
 * case either — the neutral edge is deliberately dimmer than a neutral handle ring.
 *
 * One table keyed by tone, so adding a tone to the vocabulary cannot supply one form
 * and forget the other.
 */
const HANDLE_TONE_PALETTE: Record<BlockHandleTone, { css: string; hex: string }> = {
    positive: { css: 'var(--mantine-color-green-5)', hex: '#43b581' },
    negative: { css: 'var(--mantine-color-red-5)', hex: '#ed4245' },
    caution: { css: 'var(--mantine-color-yellow-5)', hex: '#faa61a' },
    neutral: { css: 'var(--mantine-color-dark-3)', hex: '#5b5f6d' },
};

/** Tone → Mantine CSS variable, for handles and labels in the DOM. */
export const HANDLE_TONE_COLORS: Record<BlockHandleTone, string> = {
    positive: HANDLE_TONE_PALETTE.positive.css,
    negative: HANDLE_TONE_PALETTE.negative.css,
    caution: HANDLE_TONE_PALETTE.caution.css,
    neutral: HANDLE_TONE_PALETTE.neutral.css,
};

/**
 * Whether a block's exits should be drawn with their declared labels.
 *
 * Only when a block declares more than one. Every block declares at least one
 * handle, and the single-exit blocks all call theirs "Then" — labelling those would
 * stamp "THEN" on every such card and edge for no information gained. One exit is
 * the unlabelled default arrow it has always been.
 *
 * Shared by the card and the edge renderer so the two cannot disagree about which
 * exits are worth naming.
 */
export function handlesAreLabelled(handles: readonly BlockOutputHandle[]): boolean {
    return handles.length > 1;
}

/** Tone → flat hex, for edges React Flow paints into SVG. */
export const HANDLE_TONE_HEX: Record<BlockHandleTone, string> = {
    positive: HANDLE_TONE_PALETTE.positive.hex,
    negative: HANDLE_TONE_PALETTE.negative.hex,
    caution: HANDLE_TONE_PALETTE.caution.hex,
    neutral: HANDLE_TONE_PALETTE.neutral.hex,
};

/** Compact duration for card summaries: 90000 -> "1m 30s". */
export function formatDuration(ms: number): string {
    if (ms <= 0) return '0s';
    const units: [number, string][] = [
        [86_400_000, 'd'],
        [3_600_000, 'h'],
        [60_000, 'm'],
        [1_000, 's'],
    ];
    const parts: string[] = [];
    let rest = ms;
    for (const [size, suffix] of units) {
        const count = Math.floor(rest / size);
        if (count > 0) {
            parts.push(`${count}${suffix}`);
            rest -= count * size;
        }
        if (parts.length === 2) break;
    }
    return parts.length > 0 ? parts.join(' ') : `${ms}ms`;
}

/**
 * Sensible starting `data` when a node is dropped onto the canvas, seeded from the
 * block's own declared `defaultValue`s.
 *
 * A field with no declared default seeds nothing. That is deliberate: an empty
 * string was never a meaningful default, and the schema rejects one anyway, so a
 * key is better absent than present-and-invalid.
 *
 * A non-primitive default is **copied**, not shared. The descriptor is fetched
 * once and held for the session, so assigning its array or object by reference
 * would give every node dropped from that block the same one — and a single
 * node's edit would rewrite the declared default and every sibling along with it.
 *
 * The copy was shallow while every non-scalar default was a list of strings, with
 * a note that a default holding *objects* would reintroduce the aliasing one
 * level down. `eligibility` is that default, so this is now `structuredClone`:
 * the depth of a default is the declaring block's business, and a copy that is
 * correct only for the shapes shipped today is a trap for the next one.
 */
export function defaultDataFor(descriptor: NodeDescriptor): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const field of descriptor.configFields) {
        if (field.defaultValue !== undefined) {
            data[field.key] =
                typeof field.defaultValue === 'object'
                    ? structuredClone(field.defaultValue)
                    : field.defaultValue;
        }
    }
    return data;
}

/** An empty graph, used when creating a flow or recovering from a missing one. */
export function emptyGraph(): FlowGraph {
    return { version: FLOW_GRAPH_VERSION, nodes: [], edges: [] };
}

/** Discord role colour int → CSS hex. `0` means "no colour", so fall back to grey. */
export function roleColorHex(color: number): string {
    if (!color) return '#9aa0ac';
    return `#${color.toString(16).padStart(6, '0')}`;
}
