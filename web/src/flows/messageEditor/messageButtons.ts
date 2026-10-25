/**
 * Every edit the message window makes to a message's buttons, as a pure function of the list
 * before it — a new array each time, as `messageDraft.ts` does for the message, so the row and
 * Cancel can tell an edit from no edit by identity.
 */

import type { MessageButton } from '@brattybot/web-sdk';
import { slugifyResourceName, uniqueResourceKey } from '../resourceAdoption';

/** What a new button is called until someone says otherwise. */
export const NEW_BUTTON_LABEL = 'New button';

/** How many buttons sit side by side before Discord starts a new row. */
export const BUTTONS_PER_ROW = 5;

/**
 * `buttons` with a new one at the end: "New button", a Primary, keyed by its label and kept
 * unique among the others, so it is a button the save takes the moment it exists.
 */
export function addButton(buttons: readonly MessageButton[]): MessageButton[] {
    const key = uniqueResourceKey(slugifyResourceName(NEW_BUTTON_LABEL), buttons);
    return [...buttons, { key, label: NEW_BUTTON_LABEL, style: 'Primary' }];
}

/** `buttons` with button `index` changed by `patch`. */
export function updateButton(
    buttons: readonly MessageButton[],
    index: number,
    patch: Partial<MessageButton>
): MessageButton[] {
    return buttons.map((button, at) => (at === index ? { ...button, ...patch } : button));
}

/** `buttons` without button `index`. */
export function removeButton(buttons: readonly MessageButton[], index: number): MessageButton[] {
    return buttons.filter((_button, at) => at !== index);
}

/** The buttons as Discord lays them out: in order, five to a row. */
export function buttonRows<TButton>(buttons: readonly TButton[]): TButton[][] {
    const rows: TButton[][] = [];
    for (let start = 0; start < buttons.length; start += BUTTONS_PER_ROW) {
        rows.push(buttons.slice(start, start + BUTTONS_PER_ROW));
    }
    return rows;
}
