/**
 * `defaultDataFor` seeds a newly dropped node and backfills a loaded one, so what it
 * omits matters as much as what it includes.
 */

import { describe, expect, it } from 'vitest';
import type { NodeDescriptor } from '../../api/types';
import { defaultDataFor } from '../nodeMeta';

function descriptorWith(configFields: NodeDescriptor['configFields']): NodeDescriptor {
    return {
        type: 'test.block',
        kind: 'action',
        label: 'Test',
        description: 'A block that exists to be seeded.',
        group: 'actions',
        icon: '🧪',
        configFields,
        handles: [{ label: 'Then', tone: 'neutral' }],
        outputs: [],
        requires: [],
        capabilities: [],
        canSuspend: false,
    };
}

describe('defaultDataFor', () => {
    it('seeds every field that declares a default', () => {
        const descriptor = descriptorWith([
            { key: 'label', label: 'Label', control: 'text', defaultValue: 'Click me' },
            { key: 'durationMs', label: 'Wait', control: 'duration', defaultValue: 300_000 },
        ]);
        expect(defaultDataFor(descriptor)).toEqual({ label: 'Click me', durationMs: 300_000 });
    });

    it('omits fields with no declared default rather than seeding an empty string', () => {
        // An empty string was never a meaningful default, and the schemas reject one.
        const descriptor = descriptorWith([
            { key: 'roleId', label: 'Role', control: 'rolePicker' },
            { key: 'message', label: 'Message', control: 'longText' },
        ]);
        expect(defaultDataFor(descriptor)).toEqual({});
    });

    it('seeds nothing for a block with no fields', () => {
        expect(defaultDataFor(descriptorWith([]))).toEqual({});
    });

    it('lets a stored value win over a declared default, as the load backfill relies on', () => {
        const descriptor = descriptorWith([
            { key: 'eventKind', label: 'Wait for', control: 'select', defaultValue: 'buttonClick', options: [] },
            { key: 'other', label: 'Other', control: 'text', defaultValue: 'seeded' },
        ]);
        const stored = { eventKind: 'reactionAdd' };
        expect({ ...defaultDataFor(descriptor), ...stored }).toEqual({
            eventKind: 'reactionAdd',
            other: 'seeded',
        });
    });
});
