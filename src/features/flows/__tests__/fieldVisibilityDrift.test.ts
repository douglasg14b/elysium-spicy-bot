import { describe, expect, it } from 'vitest';
import { effectiveFieldValue, isFieldVisible, resolveOutputValueKind } from '../blocks/manifest';
// Typed as the browser declares them: its arrays are mutable, and a mutable value is
// accepted where the server asks for a readonly one, but not the other way round.
import type { BlockConfigField, BlockOutputDeclaration } from '../../../../web/src/api/types';
import * as browser from '../../../../web/src/flows/variables';

/**
 * The browser's copies of the visibility and value-kind helpers answer exactly as the
 * server's do.
 *
 * Hand-mirrored for the reason every browser copy is (the web workspace cannot import
 * the bot), so this runs both over the same cases — the ones where a mirror is likeliest
 * to drift: an empty string read as unset, a sibling the descriptor does not declare,
 * and a derived kind for an option the map leaves out. Lives beside the authority, as
 * the other mirror gates do; `variables.ts` imports only types, so the root workspace
 * can run it.
 */

const VALUE_TYPE: BlockConfigField = {
    key: 'valueType',
    label: 'Value',
    control: 'select',
    defaultValue: 'text',
    options: [
        { value: 'text', label: 'Text' },
        { value: 'time', label: 'Current time' },
        { value: 'number', label: 'Number' },
    ],
};

const NOTE: BlockConfigField = {
    key: 'note',
    label: 'Note',
    control: 'text',
    visibleWhen: { field: 'valueType', equals: ['text', 'number'] },
};

const TYPED: BlockOutputDeclaration = {
    naming: 'authored',
    fromField: 'outputKey',
    label: 'The value',
    valueKindFrom: { field: 'valueType', kinds: { time: 'time' } },
};

const CONFIGS: readonly Record<string, unknown>[] = [
    {},
    { valueType: '' },
    { valueType: 'text', note: 'held' },
    { valueType: 'time', note: 'held' },
    { valueType: 'number' },
    { valueType: 'unlisted' },
    { valueType: 7 },
];

const FIELD_SETS: readonly (readonly BlockConfigField[])[] = [[VALUE_TYPE, NOTE], [NOTE]];

describe('the browser mirror of field visibility and value kinds', () => {
    it.each(CONFIGS)('reads the current value of %j the same way', (config) => {
        expect(browser.effectiveFieldValue(VALUE_TYPE, config)).toEqual(effectiveFieldValue(VALUE_TYPE, config));
    });

    it.each(CONFIGS)('decides visibility for %j the same way', (config) => {
        for (const fields of FIELD_SETS) {
            expect(browser.isFieldVisible(NOTE, fields, config)).toBe(isFieldVisible(NOTE, fields, config));
        }
    });

    it.each(CONFIGS)('resolves a derived kind for %j the same way', (config) => {
        expect(browser.resolveOutputValueKind(TYPED, [VALUE_TYPE], config)).toBe(
            resolveOutputValueKind(TYPED, [VALUE_TYPE], config)
        );
    });
});
