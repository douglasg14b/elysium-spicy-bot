import { z } from 'zod';
import type { BlockManifest } from '../../../../../blocks/manifest';

/**
 * A block that records a value, so the write channel has a producer to prove.
 *
 * It lives in a fixture tree rather than in the product blocks because nothing a
 * member could want is "write a literal into a variable" — a real producer writes
 * something it *learned* (the ticket it opened, the option somebody picked), and
 * none of those exist yet. Shipping this one to a palette would be offering an
 * author a block whose only use is testing the engine.
 *
 * It is nonetheless a **real** block against the real contract: discovered by the
 * same scan, validated by the same schema, run by the same executor. A hand-built
 * stub handed straight to `executeFlowSegment` would prove the executor calls a
 * function, not that a block written the documented way can record a value.
 */
export const ACTION_RECORD_VALUE = 'fixture.recordValue';

export const recordValueConfigSchema = z.object({
    /** The flat, author-declared name later blocks read as `{{var.<name>}}`. */
    outputKey: z.string().min(1),
    value: z.string(),
});

export type RecordValueConfig = z.infer<typeof recordValueConfigSchema>;

export const block: BlockManifest<RecordValueConfig> = {
    type: ACTION_RECORD_VALUE,
    kind: 'action',
    label: 'Record Value',
    description: 'Stashes a value for a later block to read. Test fixture, not for a palette.',
    group: 'actions',
    icon: '📝',
    configSchema: recordValueConfigSchema,
    configFields: [
        { key: 'outputKey', label: 'Name', control: 'text' },
        // Deliberately NOT `rendersTokens`: this field is a value to store, not
        // copy a member reads, and the distinction is the whole point of the flag.
        { key: 'value', label: 'Value', control: 'text' },
    ],
    handles: [{ label: 'Next', tone: 'neutral' }],
    // Declared even though nothing reads `outputs` yet: a block that writes a
    // value and declares none is the state the eventual "declared matches
    // written" check exists to catch, and a fixture should not be the first
    // thing that fails it. The key is authored config here, so this names the
    // shape rather than a specific key.
    outputs: [{ key: 'outputKey', label: 'The recorded value' }],
    requires: ['subject'],
    capabilities: [],
    canSuspend: false,
    run(config, context) {
        context.setOutput(config.outputKey, config.value);
        return { kind: 'continue' };
    },
};
