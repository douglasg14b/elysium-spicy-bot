/**
 * Per-node-type presentation metadata: the emoji/colour language shared by the
 * palette, the canvas cards and the inspector. Node *kinds* drive colour
 * (trigger=green, condition=amber, action=brand cyan) per the flow-builder mockup.
 */

import type { FlowGraph, GuildChannel, GuildRole, NodeKind } from '../api/types';

export interface KindStyle {
    /** Mantine colour key for badges/icons. */
    color: string;
    /** CSS gradient for the card header, mirroring the mockup. */
    headerGradient: string;
    /** Header text colour — the cyan header wants dark ink, the others white. */
    headerText: string;
    /** Translucent tint for palette icon chips. */
    softBg: string;
    label: string;
}

export const KIND_STYLES: Record<NodeKind, KindStyle> = {
    trigger: {
        color: 'green',
        headerGradient: 'linear-gradient(135deg, #3aa876, #43b581)',
        headerText: '#ffffff',
        softBg: 'rgba(67,181,129,.2)',
        label: 'Trigger',
    },
    condition: {
        color: 'yellow',
        headerGradient: 'linear-gradient(135deg, #e0940f, #faa61a)',
        headerText: '#ffffff',
        softBg: 'rgba(250,166,26,.2)',
        label: 'Condition',
    },
    action: {
        color: 'brand',
        headerGradient:
            'linear-gradient(135deg, var(--mantine-color-brand-7), var(--mantine-color-brand-6))',
        headerText: '#041017',
        softBg: 'rgba(0,162,255,.16)',
        label: 'Action',
    },
};

/** Emoji per node type, matching the mockup's palette glyphs. */
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

/** One-line description shown in the inspector header. Cheeky, per the persona. */
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
 * The executor's `resolveWaitExit` reads the same `timeout` id.
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

/** Sensible starting `data` when a node is dropped onto the canvas. */
export function defaultDataFor(type: string): Record<string, unknown> {
    switch (type) {
        case 'trigger.buttonClick':
            return { label: 'Click me', style: 'Primary' };
        case 'trigger.reactionAdd':
            return { channelId: '', messageId: '', emoji: '' };
        case 'condition.hasRole':
        case 'action.assignRole':
        case 'action.removeRole':
            return { roleId: '' };
        case 'condition.inChannel':
            return { channelId: '' };
        case 'action.sendDM':
            return { message: '' };
        case 'action.sendMessage':
            return { channelId: '', message: '' };
        case 'action.postEmbed':
            return { channelId: '', title: '', description: '', color: '#00A2FF' };
        case 'action.delay':
            // Five minutes is a sane, obviously-editable starting point.
            return { durationMs: 5 * 60_000 };
        case 'action.waitForEvent':
            // `timeoutMs` is optional server-side and must be positive when present,
            // so leave it off entirely rather than seeding a zero.
            return { eventKind: 'buttonClick' };
        default:
            return {};
    }
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
