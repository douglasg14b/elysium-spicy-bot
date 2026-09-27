import { screen } from '@testing-library/react';

/**
 * The flows list's row for a flow, found by the name it shows.
 *
 * Matched inside a table cell, because the same name also appears in dialog titles and
 * notifications once a scenario gets going, and a row action must be clicked on the row.
 */
export async function flowRow(name: string): Promise<HTMLElement> {
    const cell = await screen.findByText(name, { selector: 'td *' });
    const row = cell.closest('tr');
    if (!row) throw new Error(`"${name}" is not inside a table row.`);
    return row;
}
