/**
 * Shared shapes for the control library.
 *
 * A control renders from a {@link BlockConfigField} declaration alone, plus the
 * current value and a way to change it. Nothing here knows a block type: the only
 * switch in this directory is on `field.control`, which is the control vocabulary
 * the block contract defines as its extension point.
 */

import type { Eligibility, BlockConfigField, GuildChannel, GuildRole } from '../../api/types';
import type { AvailableVariable } from '../variables';

/**
 * What a control needs from the page beyond its own declaration.
 *
 * Only the pickers and the copy fields read this, but passing one object keeps
 * every control's signature identical, so the dispatcher never special-cases who
 * gets what.
 */
export interface ControlContext {
    roles: GuildRole[];
    channels: GuildChannel[];
    /**
     * Variables some upstream block writes, for the copy fields to offer.
     *
     * A property of the *node*, not of the field, which is why it arrives through
     * the context rather than the declaration: the same `longText` field offers
     * different variables depending on what is wired above it.
     */
    variables: AvailableVariable[];
}

/**
 * Emit a change for one config key.
 *
 * `undefined` means *remove the key* — how an `optional` duration says "unset"
 * rather than writing a zero the server would reject. The consumer deletes it
 * outright rather than leaving it present-but-`undefined`; see `updateNodeConfig`
 * in `FlowBuilderPage` for why the difference is load-bearing.
 *
 * `string[]` is `textList`'s value and `Eligibility` is `eligibility`'s. Both
 * are a **new value every time** rather than a mutated one: the patch lands in
 * React state, so a control that edited its current value in place would write a
 * value the renderer cannot tell apart from the old one.
 *
 * A union of the concrete value types rather than `unknown`, deliberately. It is
 * the one place that says what a `node.data` value may be, so a control emitting
 * a shape no schema accepts fails here rather than at save time in front of an
 * author.
 */
export type ControlChange = (value: string | number | string[] | Eligibility | undefined) => void;

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

/**
 * Narrow an unknown `node.data` value to a list of strings.
 *
 * Non-string entries are dropped rather than coerced. A saved graph whose list
 * holds a number got there through an API the schema rejects, so showing it as
 * `"3"` would invite an author to keep a value the save will not take.
 */
export function asTextList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
