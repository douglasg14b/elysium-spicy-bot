import { z } from 'zod';
import type { BlockManifest } from '../../../../../blocks/manifest';

/**
 * A deliberately boring block that satisfies the contract completely.
 *
 * It is **permanent**, and it lives outside the product blocks tree so it never
 * appears in a palette. Two jobs: it is the positive control the conformance
 * suite checks itself against, and it keeps the one-directory promise covered
 * continuously — if authoring a block ever comes to need something outside its
 * own directory, this block stops working and a test says so.
 */
export const FIXTURE_BLOCK_TYPE = 'fixture.conforming';

export const fixtureConfigSchema = z.object({
    roleId: z.string().min(1),
    note: z.string().max(40).optional(),
    mood: z.enum(['sweet', 'mean']).default('mean'),
});

export type FixtureConfig = z.infer<typeof fixtureConfigSchema>;

export const block: BlockManifest<FixtureConfig> = {
    type: FIXTURE_BLOCK_TYPE,
    kind: 'action',
    label: 'Fixture Block',
    description: 'Does nothing, conformingly.',
    group: 'actions',
    icon: '🧪',
    configSchema: fixtureConfigSchema,
    configFields: [
        { key: 'roleId', label: 'Role', control: 'rolePicker' },
        { key: 'note', label: 'Note', control: 'text', maxLength: 40 },
        {
            key: 'mood',
            label: 'Mood',
            control: 'segmented',
            defaultValue: 'mean',
            options: [
                { value: 'sweet', label: 'Sweet' },
                { value: 'mean', label: 'Mean' },
            ],
        },
    ],
    handles: [{ label: 'Next', tone: 'neutral' }],
    outputs: [],
    requires: ['member'],
    capabilities: [],
    canSuspend: false,
    run() {
        return { kind: 'continue' };
    },
};
