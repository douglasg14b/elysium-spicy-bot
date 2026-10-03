import { z } from 'zod';
import type { BlockManifest } from '../../../../../blocks/manifest';

/**
 * Records `context.startedAt`, so a test can read the run's start time back out of the
 * bag on either side of a park — the run-start capability's proof, until a shipped
 * block reads it.
 */
export const FIXTURE_RECORD_START = 'fixture.recordStart';

/** The variable `run` writes the start time into, as ISO, or null when the run has none. */
export const RECORDED_START = 'recordedStart';

export const recordStartConfigSchema = z.object({});

export type RecordStartConfig = z.infer<typeof recordStartConfigSchema>;

export const block: BlockManifest<RecordStartConfig> = {
    type: FIXTURE_RECORD_START,
    kind: 'action',
    label: 'Record Start',
    description: 'Notes when the run started. Test fixture, not for a palette.',
    group: 'actions',
    icon: '⏱️',
    configSchema: recordStartConfigSchema,
    configFields: [],
    handles: [{ label: 'Next', tone: 'neutral' }],
    outputs: [{ naming: 'fixed', key: RECORDED_START, label: 'When the run started', valueKind: 'time' }],
    requires: [],
    capabilities: [],
    canSuspend: false,
    run(_config, context) {
        context.setOutput(RECORDED_START, context.startedAt ? context.startedAt.toISOString() : null);
        return { kind: 'continue' };
    },
};
