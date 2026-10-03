import { z } from 'zod';
import type { BlockManifest } from '../../../../../blocks/manifest';
import { VARIABLE_NAME_MESSAGE, VARIABLE_NAME_SHAPE } from '../../../../../blocks/variableName';

/**
 * A producer whose output's kind depends on its own `select` — `valueKindFrom`'s
 * proof, until a shipped block declares one.
 *
 * A fixture rather than a product block for the reason `producer/actionRecordValue`
 * gives: writing a literal into a variable is a test of the engine, not something a
 * member wants. Discovered, validated and run like any other block, so it proves the
 * contract as written rather than a stub of it.
 */
export const FIXTURE_RECORD_TYPED = 'fixture.recordTyped';

/** What `run` writes for the `text` option, so a test can tell it from a time. */
export const RECORDED_TEXT = 'not a time';

export const recordTypedConfigSchema = z.object({
    outputKey: z.string().min(1).regex(VARIABLE_NAME_SHAPE, VARIABLE_NAME_MESSAGE),
    valueType: z.enum(['text', 'time']).default('text'),
});

export type RecordTypedConfig = z.infer<typeof recordTypedConfigSchema>;

export const block: BlockManifest<RecordTypedConfig> = {
    type: FIXTURE_RECORD_TYPED,
    kind: 'action',
    label: 'Record Typed',
    description: 'Stashes text or the current time under a name. Test fixture, not for a palette.',
    group: 'actions',
    icon: '🧪',
    configSchema: recordTypedConfigSchema,
    configFields: [
        { key: 'outputKey', label: 'Name', control: 'text' },
        {
            key: 'valueType',
            label: 'Value',
            control: 'select',
            defaultValue: 'text',
            options: [
                { value: 'text', label: 'Some text' },
                { value: 'time', label: 'Current time' },
            ],
        },
    ],
    handles: [{ label: 'Next', tone: 'neutral' }],
    // `text` is left out of `kinds` on purpose: it means "no kind", which is the
    // case the producer map must keep rather than drop.
    outputs: [
        {
            naming: 'authored',
            fromField: 'outputKey',
            label: 'The recorded value',
            valueKindFrom: { field: 'valueType', kinds: { time: 'time' } },
        },
    ],
    requires: [],
    capabilities: [],
    canSuspend: false,
    run(config, context) {
        context.setOutput(config.outputKey, config.valueType === 'time' ? new Date().toISOString() : RECORDED_TEXT);
        return { kind: 'continue' };
    },
};
