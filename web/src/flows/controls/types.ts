/**
 * Shared shapes for the control library.
 *
 * A control renders from a {@link BlockConfigField} declaration alone, plus the
 * current value and a way to change it. Nothing here knows a block type: the only
 * switch in this directory is on `field.control`, which is the control vocabulary
 * the block contract defines as its extension point.
 */

import type { BlockConfigField, GuildChannel, GuildRole } from '../../api/types';

/**
 * What a control needs from the page beyond its own declaration.
 *
 * Only the pickers read this, but passing one object keeps every control's
 * signature identical, so the dispatcher never special-cases who gets what.
 */
export interface ControlContext {
    roles: GuildRole[];
    channels: GuildChannel[];
}

/**
 * Emit a change for one config key.
 *
 * `undefined` means *remove the key* — how an `optional` duration says "unset"
 * rather than writing a zero the server would reject. The consumer deletes it
 * outright rather than leaving it present-but-`undefined`; see `updateNodeConfig`
 * in `FlowBuilderPage` for why the difference is load-bearing.
 */
export type ControlChange = (value: string | number | undefined) => void;

/** Props every control in this directory takes. */
export interface ControlProps<TField extends BlockConfigField = BlockConfigField> {
    field: TField;
    /** The current `node.data` value for `field.key`, whatever shape it is on the wire. */
    value: unknown;
    onChange: ControlChange;
    context: ControlContext;
}

/** Narrow an unknown `node.data` value to a string for controlled inputs. */
export function asText(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/** Narrow an unknown `node.data` value to a finite number, or `null` when unset. */
export function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
