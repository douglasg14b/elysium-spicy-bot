/**
 * The card-summary interpreter, which turns a block's declared `cardSummary` into
 * the one line under a node's label.
 *
 * These cases are the contract's worked examples plus the places where the
 * implementation had to choose. The `emptyText` cases are the load-bearing ones:
 * they pin the decoration rule that every shipped block's copy depends on.
 */

import { describe, expect, it } from 'vitest';
import type { GuildChannel, GuildRole, NodeDescriptor } from '../../api/types';
import { summarizeFromDescriptor } from '../cardSummary';

const ROLES: GuildRole[] = [{ id: 'r1', name: 'Moderator', color: 0, position: 1 }];
const CHANNELS: GuildChannel[] = [{ id: 'c1', name: 'general' }];

/** A descriptor carrying only what the summary reads. */
function descriptorWith(
    configFields: NodeDescriptor['configFields'],
    cardSummary: NodeDescriptor['cardSummary']
): NodeDescriptor {
    return {
        type: 'test.block',
        kind: 'action',
        label: 'Test',
        description: 'A block that exists to be summarised.',
        group: 'actions',
        icon: '🧪',
        configFields,
        cardSummary,
        handles: [{ label: 'Then', tone: 'neutral' }],
        outputs: [],
        requires: [],
        capabilities: [],
        canSuspend: false,
    };
}

const summarize = (
    descriptor: NodeDescriptor,
    config: Record<string, unknown>
): string => summarizeFromDescriptor(descriptor, config, ROLES, CHANNELS);

describe('summarizeFromDescriptor', () => {
    it('falls back to generic copy when a block declares no summary', () => {
        expect(summarize(descriptorWith([], undefined), {})).toBe('Click to configure');
    });

    it('renders a literal-only summary', () => {
        const descriptor = descriptorWith([], [{ text: 'Any new member' }]);
        expect(summarize(descriptor, {})).toBe('Any new member');
    });

    it('resolves a role to @name and a channel to #name', () => {
        const descriptor = descriptorWith(
            [
                { key: 'roleId', label: 'Role', control: 'rolePicker' },
                { key: 'channelId', label: 'Channel', control: 'channelPicker' },
            ],
            [{ key: 'roleId' }, { text: ' in ' }, { key: 'channelId' }]
        );
        expect(summarize(descriptor, { roleId: 'r1', channelId: 'c1' })).toBe(
            '@Moderator in #general'
        );
    });

    it('keeps prefix and suffix around emptyText when a field is unset', () => {
        // `action.assignRole` pairs `prefix: 'Assign '` with a lowercase
        // `'no role picked'`, which only reads as a sentence when the prefix
        // survives. Dropping it would silently reword ten cards.
        const descriptor = descriptorWith(
            [{ key: 'roleId', label: 'Role', control: 'rolePicker' }],
            [{ key: 'roleId', prefix: 'Assign ', emptyText: 'no role picked' }]
        );
        expect(summarize(descriptor, {})).toBe('Assign no role picked');
        expect(summarize(descriptor, { roleId: 'r1' })).toBe('Assign @Moderator');
    });

    it('keeps a suffix around emptyText too', () => {
        const descriptor = descriptorWith(
            [{ key: 'channelId', label: 'Channel', control: 'channelPicker' }],
            [{ key: 'channelId', prefix: 'Is it ', suffix: '?', emptyText: 'no channel picked' }]
        );
        expect(summarize(descriptor, {})).toBe('Is it no channel picked?');
        expect(summarize(descriptor, { channelId: 'c1' })).toBe('Is it #general?');
    });

    it('treats a set-but-unresolvable id as unset', () => {
        const descriptor = descriptorWith(
            [{ key: 'roleId', label: 'Role', control: 'rolePicker' }],
            [{ key: 'roleId', prefix: 'Assign ', emptyText: 'no role picked' }]
        );
        expect(summarize(descriptor, { roleId: 'deleted-role' })).toBe('Assign no role picked');
    });

    it('drops a hideWhenEmpty part along with its prefix, leaving no dangling separator', () => {
        const descriptor = descriptorWith(
            [
                { key: 'channelId', label: 'Channel', control: 'channelPicker' },
                { key: 'message', label: 'Message', control: 'longText' },
            ],
            [
                { key: 'channelId', emptyText: 'no channel picked' },
                { key: 'message', prefix: ' · ', quote: true, truncate: 20, hideWhenEmpty: true },
            ]
        );
        expect(summarize(descriptor, { channelId: 'c1' })).toBe('#general');
        expect(summarize(descriptor, { channelId: 'c1', message: 'hi' })).toBe('#general · "hi"');
    });

    it('discards every later part under stopIfEmpty, and renders emptyText bare', () => {
        const descriptor = descriptorWith(
            [
                { key: 'label', label: 'Label', control: 'text' },
                {
                    key: 'style',
                    label: 'Style',
                    control: 'segmented',
                    options: [{ value: 'Primary', label: 'Primary' }],
                },
            ],
            [
                {
                    key: 'label',
                    quote: true,
                    truncate: 24,
                    emptyText: 'Unlabelled button',
                    stopIfEmpty: true,
                },
                { key: 'style', prefix: ' · ' },
            ]
        );
        // The style part is discarded entirely, even though it has a value.
        expect(summarize(descriptor, { style: 'Primary' })).toBe('Unlabelled button');
        expect(summarize(descriptor, { label: 'Agree', style: 'Primary' })).toBe(
            '"Agree" · Primary'
        );
    });

    it('truncates before quoting, so the quotes are never clipped', () => {
        const descriptor = descriptorWith(
            [{ key: 'message', label: 'Message', control: 'longText' }],
            [{ key: 'message', quote: true, truncate: 10 }]
        );
        expect(summarize(descriptor, { message: 'abcdefghijklmnop' })).toBe('"abcdefghi…"');
    });

    it('renders a select/segmented value as its declared label, never the raw value', () => {
        const descriptor = descriptorWith(
            [
                {
                    key: 'eventKind',
                    label: 'Wait for',
                    control: 'select',
                    options: [{ value: 'buttonClick', label: 'They click a flow button' }],
                },
            ],
            [{ key: 'eventKind', prefix: 'Await ' }]
        );
        expect(summarize(descriptor, { eventKind: 'buttonClick' })).toBe(
            'Await They click a flow button'
        );
    });

    it('formats a duration, and treats a non-positive one as unset', () => {
        const descriptor = descriptorWith(
            [{ key: 'timeoutMs', label: 'Cap', control: 'duration', optional: true }],
            [{ key: 'timeoutMs', prefix: ' · ', suffix: ' cap', hideWhenEmpty: true }]
        );
        expect(summarize(descriptor, { timeoutMs: 300_000 })).toBe(' · 5m cap');
        expect(summarize(descriptor, { timeoutMs: 90_000 })).toBe(' · 1m 30s cap');
        expect(summarize(descriptor, { timeoutMs: 0 })).toBe('Click to configure');
        expect(summarize(descriptor, {})).toBe('Click to configure');
    });
});
