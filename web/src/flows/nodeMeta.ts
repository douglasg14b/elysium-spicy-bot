/**
 * Presentation helpers shared by the palette, the canvas cards and the inspector.
 * Node *kinds* drive colour (trigger=green, condition=amber, action=brand cyan)
 * per the flow-builder mockup.
 *
 * **Half of this file is already dead.** Every per-block catalogue below —
 * `NODE_EMOJI`, `NODE_DESCRIPTION`, `branchHandles`, `summarizeNode`, `kindOf`,
 * `isCondition`, `isWaitForEvent`, `WAIT_EVENT_LABELS` — has zero callers: the
 * builder now renders from the block descriptor the server sends. They are kept
 * only so their deletion is one reviewable act rather than noise inside this
 * change, and they are the *last* copy of block metadata in the browser.
 *
 * **Do not edit them, and do not add to them.** Changing how a card reads means
 * changing that block's `cardSummary` in `src/features/flows/blocks/<block>/`;
 * editing `summarizeNode` changes nothing a user can see.
 *
 * Not everything here is dead, which is why the boundary is worth stating rather
 * than inferring from position in the file: `formatDuration`, `roleColorHex`,
 * `emptyGraph`, `KIND_STYLES`, the handle-tone palettes, `handlesAreLabelled` and
 * `defaultDataFor` are live and generic, and they stay.
 */

import type {
    BlockHandleTone,
    BlockOutputHandle,
    FlowGraph,
    GuildChannel,
    GuildRole,
    NodeDescriptor,
    NodeKind,
} from '../api/types';

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
 * Emoji per node type, matching the mockup's palette glyphs.
 *
 * Each block also declares its own `icon` on the server, and these are kept in
 * step by hand until the builder reads the descriptor off the wire — at which
 * point this map goes away rather than being maintained twice.
 */
const NODE_EMOJI: Record<string, string> = {
    'trigger.buttonClick': '🔘',
    'trigger.memberJoin': '🚪',
    'trigger.reactionAdd': '💥',
    'condition.hasRole': '🎭',
    'condition.inChannel': '📍',
    'action.assignRole': '➕',
    'action.removeRole': '➖',
    'action.sendDM': '✉️',
    'action.sendMessage': '💬',
    'action.postEmbed': '🖼️',
    'action.delay': '⏳',
    'action.waitForEvent': '⏸️',
};

export function nodeEmoji(type: string): string {
    return NODE_EMOJI[type] ?? '⚙️';
}

/**
 * One-line description shown in the inspector header. Cheeky, per the persona.
 *
 * Like the emoji above, the server declares its own `description` per block.
 * Both copies go when the builder renders from the descriptor.
 */
const NODE_DESCRIPTION: Record<string, string> = {
    'trigger.buttonClick': 'Fires when a member clicks your button. The classic rules-gate opener.',
    'trigger.memberJoin': 'Fires the moment someone walks through the door. No config needed.',
    'trigger.reactionAdd': 'Fires when a specific emoji lands on a specific message.',
    'condition.hasRole': 'Splits the flow on whether the member already holds a role.',
    'condition.inChannel': 'Splits the flow on where the event happened.',
    'action.assignRole': 'Grants a role to the member who triggered this flow. Unlocks the good stuff.',
    'action.removeRole': 'Takes a role away. Useful for swapping someone out of the waiting room.',
    'action.sendDM': 'Slides into their DMs with a message from the bot.',
    'action.sendMessage': 'Posts a message to a channel of your choosing.',
    'action.postEmbed': 'Posts a fancy embed — title, blurb, and a colour stripe.',
    'action.delay': 'Parks the flow for a while, then picks up where it left off. Survives restarts.',
    'action.waitForEvent':
        'Holds the flow until this member does something — or until your timeout runs out.',
};

export function nodeDescription(type: string): string {
    return NODE_DESCRIPTION[type] ?? 'Configure this node below.';
}

/** Derives a node's kind from its `type` prefix, so we never need a lookup. */
export function kindOf(type: string): NodeKind {
    if (type.startsWith('trigger.')) return 'trigger';
    if (type.startsWith('condition.')) return 'condition';
    return 'action';
}

/** Conditions branch; everything else has a single output. */
export function isCondition(type: string): boolean {
    return kindOf(type) === 'condition';
}

/** The wait node is an action, but it also forks: the event arrived vs. it timed out. */
export const WAIT_FOR_EVENT_TYPE = 'action.waitForEvent';

export function isWaitForEvent(type: string): boolean {
    return type === WAIT_FOR_EVENT_TYPE;
}

/**
 * Output handle ids for nodes that fork. Conditions use `true`/`false`; the wait
 * node uses its default (unnamed) edge for "event arrived" plus a `timeout` handle.
 *
 * These ids are the server's, declared on each block's manifest as `handles` and
 * matched against them when a graph is saved. This copy goes away when the
 * builder reads the descriptor off the wire.
 */
export function branchHandles(type: string): { id: string | undefined; label: string; color: string }[] {
    if (isCondition(type)) {
        return [
            { id: 'true', label: 'True', color: 'var(--mantine-color-green-5)' },
            { id: 'false', label: 'False', color: 'var(--mantine-color-red-5)' },
        ];
    }
    if (isWaitForEvent(type)) {
        return [
            { id: undefined, label: 'Got it', color: 'var(--mantine-color-green-5)' },
            { id: 'timeout', label: 'Timeout', color: 'var(--mantine-color-yellow-5)' },
        ];
    }
    return [];
}

/** Triggers start the flow, so they take no incoming edge. */
export function hasTargetHandle(type: string): boolean {
    return kindOf(type) !== 'trigger';
}

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

function str(data: Record<string, unknown>, key: string): string {
    const value = data[key];
    return typeof value === 'string' ? value : '';
}

function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The one-line config summary on each canvas card. Resolves role/channel IDs to
 * names when we have them, so the card never shows a raw snowflake.
 */
export function summarizeNode(
    type: string,
    data: Record<string, unknown>,
    roles: GuildRole[],
    channels: GuildChannel[]
): string {
    const roleName = (id: string): string => {
        const role = roles.find((r) => r.id === id);
        return role ? `@${role.name}` : 'no role picked';
    };
    const channelName = (id: string): string => {
        const channel = channels.find((c) => c.id === id);
        return channel ? `#${channel.name}` : 'no channel picked';
    };

    switch (type) {
        case 'trigger.buttonClick': {
            const label = str(data, 'label');
            const style = str(data, 'style') || 'Primary';
            return label ? `"${truncate(label, 24)}" · ${style}` : 'Unlabelled button';
        }
        case 'trigger.memberJoin':
            return 'Any new member';
        case 'trigger.reactionAdd': {
            const emoji = str(data, 'emoji');
            const channelId = str(data, 'channelId');
            return `${emoji || '—'} in ${channelId ? channelName(channelId) : 'no channel picked'}`;
        }
        case 'condition.hasRole': {
            const roleId = str(data, 'roleId');
            return `Checks for ${roleId ? roleName(roleId) : 'no role picked'}`;
        }
        case 'condition.inChannel': {
            const channelId = str(data, 'channelId');
            return `Is it ${channelId ? channelName(channelId) : 'no channel picked'}?`;
        }
        case 'action.assignRole': {
            const roleId = str(data, 'roleId');
            return `Assign ${roleId ? roleName(roleId) : 'no role picked'}`;
        }
        case 'action.removeRole': {
            const roleId = str(data, 'roleId');
            return `Remove ${roleId ? roleName(roleId) : 'no role picked'}`;
        }
        case 'action.sendDM': {
            const message = str(data, 'message');
            return message ? `"${truncate(message, 30)}"` : 'No message yet';
        }
        case 'action.sendMessage': {
            const channelId = str(data, 'channelId');
            const message = str(data, 'message');
            const where = channelId ? channelName(channelId) : 'no channel picked';
            return message ? `${where} · "${truncate(message, 20)}"` : where;
        }
        case 'action.postEmbed': {
            const channelId = str(data, 'channelId');
            const title = str(data, 'title');
            const where = channelId ? channelName(channelId) : 'no channel picked';
            return title ? `${where} · "${truncate(title, 20)}"` : where;
        }
        case 'action.delay': {
            const ms = num(data, 'durationMs');
            return ms ? `Wait ${formatDuration(ms)}` : 'No duration set';
        }
        case 'action.waitForEvent': {
            const kind = str(data, 'eventKind');
            const timeout = num(data, 'timeoutMs');
            const what = kind ? WAIT_EVENT_LABELS[kind] ?? kind : 'nothing picked';
            return timeout ? `Await ${what} · ${formatDuration(timeout)} cap` : `Await ${what}`;
        }
        default:
            return 'Click to configure';
    }
}

/** Human labels for the wait node's event kinds. */
export const WAIT_EVENT_LABELS: Record<string, string> = {
    memberJoin: 'a rejoin',
    reactionAdd: 'a reaction',
    buttonClick: 'a button click',
};

function num(data: Record<string, unknown>, key: string): number {
    const value = data[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

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
 */
export function defaultDataFor(descriptor: NodeDescriptor): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const field of descriptor.configFields) {
        if (field.defaultValue !== undefined) {
            data[field.key] = field.defaultValue;
        }
    }
    return data;
}

/** An empty graph, used when creating a flow or recovering from a missing one. */
export function emptyGraph(): FlowGraph {
    return { version: 1, nodes: [], edges: [] };
}

/** Discord role colour int → CSS hex. `0` means "no colour", so fall back to grey. */
export function roleColorHex(color: number): string {
    if (!color) return '#9aa0ac';
    return `#${color.toString(16).padStart(6, '0')}`;
}
