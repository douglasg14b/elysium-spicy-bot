import { describe, expect, it } from 'vitest';
import { currentValue, declaredOptionValue, parseDeclaredOption } from '../PickerControls';
import { resourceKeyFieldFor } from '../types';

/**
 * How a picker tells a declared resource apart from a real snowflake.
 *
 * Both are strings in the same dropdown, and confusing them is not a cosmetic bug: a
 * resource key handed to `roles.add()` is a run-time failure far from the cause, and a
 * snowflake mistaken for a key would be written into a declaration that install then
 * tries to create.
 */

describe('declared resource option encoding', () => {
    it('round-trips a resource key', () => {
        expect(parseDeclaredOption(declaredOptionValue('qa-channel'))).toBe('qa-channel');
    });

    it('does not treat a snowflake as a declared resource', () => {
        // A Discord id is 17-20 digits. Nothing about it should match the namespace.
        expect(parseDeclaredOption('123456789012345678')).toBeUndefined();
    });

    it('does not treat a key-shaped guild id as declared', () => {
        // The prefix is what marks a declaration, not the shape of the value — so a
        // guild object whose id somehow read like a key stays a guild object.
        expect(parseDeclaredOption('qa-channel')).toBeUndefined();
    });
});

describe('which value a picker shows as selected', () => {
    it('shows the snowflake when no resource key is set', () => {
        expect(currentValue('123456789012345678', undefined)).toBe('123456789012345678');
    });

    it('shows the declared resource when a key is set', () => {
        expect(currentValue('', 'qa-channel')).toBe(declaredOptionValue('qa-channel'));
    });

    it('prefers the key over a stale snowflake', () => {
        // Both present means the resource was installed and later re-declared, or the
        // graph moved guilds. The key is canonical; the id is a cached resolution, so
        // reading as the id would show whatever it used to point at.
        expect(currentValue('999888777666555444', 'qa-channel')).toBe(
            declaredOptionValue('qa-channel')
        );
    });

    it('shows nothing when neither is set', () => {
        expect(currentValue('', undefined)).toBeNull();
        expect(currentValue(undefined, undefined)).toBeNull();
    });

    it('ignores non-string config values rather than coercing them', () => {
        // A graph written through an API the schema rejects could hold a number here;
        // rendering it as a selection would invite keeping a value the save refuses.
        expect(currentValue(42, undefined)).toBeNull();
    });
});

describe('the sidecar field name', () => {
    it('is derived from the picker field, not hardcoded', () => {
        // Every picker field gets its own sidecar, so a block with both a channel and
        // a role picker keeps them apart.
        expect(resourceKeyFieldFor('roleId')).toBe('roleIdKey');
        expect(resourceKeyFieldFor('channelId')).toBe('channelIdKey');
    });
});
