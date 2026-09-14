/**
 * Renders a block's declared `cardSummary` into the one line under a node's label.
 *
 * The browser never knows what a block *means* here — only how a value of each
 * control type reads, which is the same knowledge the inspector already has.
 */

import type {
    BlockCardSummaryPart,
    BlockConfigField,
    GuildChannel,
    GuildRole,
    NodeDescriptor,
} from '../api/types';
import { formatDuration } from './nodeMeta';

/** Shown when a block declares no `cardSummary` at all. */
const NO_SUMMARY = 'Click to configure';

interface SummaryContext {
    roles: GuildRole[];
    channels: GuildChannel[];
}

/** Truncate to `max` characters, the last of which becomes an ellipsis. */
function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Resolve one field's current value the way that field's own `control` implies.
 *
 * Returns an empty string when the field is unset, which is what drives
 * `emptyText` / `hideWhenEmpty` / `stopIfEmpty` in the caller.
 */
function resolveValue(
    field: BlockConfigField,
    raw: unknown,
    context: SummaryContext
): string {
    switch (field.control) {
        /*
         * A set-but-unresolvable id — a deleted role, or a list that has not loaded —
         * reads as unset, so the card shows the field's own empty copy rather than a
         * bare snowflake. That deliberately conflates "never configured" with
         * "configured, then deleted"; the inspector is where that distinction gets
         * made, and this line is two lines long.
         */
        case 'rolePicker': {
            if (typeof raw !== 'string' || !raw) return '';
            const role = context.roles.find((candidate) => candidate.id === raw);
            return role ? `@${role.name}` : '';
        }
        case 'channelPicker': {
            if (typeof raw !== 'string' || !raw) return '';
            const channel = context.channels.find((candidate) => candidate.id === raw);
            return channel ? `#${channel.name}` : '';
        }
        case 'duration': {
            if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return '';
            return formatDuration(raw);
        }
        case 'segmented':
        case 'select': {
            if (typeof raw !== 'string' || !raw) return '';
            const option = field.options.find((candidate) => candidate.value === raw);
            // The declared label, never the stored value.
            return option ? option.label : raw;
        }
        case 'text':
        case 'longText':
        case 'colour':
            return typeof raw === 'string' ? raw : '';
        /*
         * Joined with ` · `, not counted. "Yes · No · Maybe" tells an author what
         * their buttons say at a glance, which is the whole job of this line;
         * "3 choices" would make them open the inspector to learn anything. A part
         * that wants the list clipped declares its own `truncate`, exactly as a
         * long message body does.
         *
         * Blank entries are dropped so a half-typed row does not show as a stray
         * separator, and a list of nothing but blanks reads as unset — which is
         * what drives `emptyText` in the caller.
         */
        case 'textList': {
            if (!Array.isArray(raw)) return '';
            return raw
                .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
                .join(' · ');
        }
        default: {
            const unhandled: never = field;
            void unhandled;
            return '';
        }
    }
}

/** Apply a part's decorations to an already-resolved, non-empty value. */
function decorate(part: Extract<BlockCardSummaryPart, { key: string }>, value: string): string {
    let text = value;
    if (part.truncate !== undefined) text = truncate(text, part.truncate);
    if (part.quote) text = `"${text}"`;
    return `${part.prefix ?? ''}${text}${part.suffix ?? ''}`;
}

/**
 * An unset field's contribution: `emptyText` in place of the value, but still
 * inside the part's `prefix`/`suffix`.
 *
 * That every block's copy depends on: `action.assignRole` pairs `prefix: 'Assign '`
 * with a lowercase `'no role picked'`, which only reads as a sentence when the
 * prefix survives ("Assign no role picked"), and `condition.inChannel` needs its
 * `'?'` suffix for the same reason.
 *
 * `quote` and `truncate` are skipped: empty copy is not the author's own text and
 * has no business being quoted or clipped.
 *
 */
function decorateEmpty(
    part: Extract<BlockCardSummaryPart, { key: string }>,
    emptyText: string
): string {
    return `${part.prefix ?? ''}${emptyText}${part.suffix ?? ''}`;
}

/**
 * Build the canvas card's one-line config summary from what the block declares.
 *
 * @param descriptor - The block's descriptor, or `undefined` for an unknown type.
 * @param config - The node's current engine `data`.
 * @param roles - Guild roles, for resolving a `rolePicker` value to `@name`.
 * @param channels - Guild channels, for resolving a `channelPicker` to `#name`.
 */
export function summarizeFromDescriptor(
    descriptor: NodeDescriptor | undefined,
    config: Record<string, unknown>,
    roles: GuildRole[],
    channels: GuildChannel[]
): string {
    if (!descriptor?.cardSummary || descriptor.cardSummary.length === 0) return NO_SUMMARY;

    const context: SummaryContext = { roles, channels };
    const pieces: string[] = [];

    for (const part of descriptor.cardSummary) {
        if (part.key === undefined) {
            pieces.push(part.text);
            continue;
        }

        const field = descriptor.configFields.find((candidate) => candidate.key === part.key);
        // Conformance proves every `key` names a real field server-side, so a miss
        // here means the descriptor and its fields disagree — skip rather than
        // inventing copy for a field that does not exist.
        if (!field) continue;

        const value = resolveValue(field, config[part.key], context);

        if (value) {
            pieces.push(decorate(part, value));
            continue;
        }

        // Unset, in the three ways a part can ask for.
        // `stopIfEmpty` discards every later part, so its `emptyText` really is the
        // whole line — no surrounding decoration.
        if (part.stopIfEmpty) return part.emptyText ?? '';
        if (part.hideWhenEmpty) continue;
        if (part.emptyText !== undefined) pieces.push(decorateEmpty(part, part.emptyText));
    }

    const summary = pieces.join('');
    return summary || NO_SUMMARY;
}
