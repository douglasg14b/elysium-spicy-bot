import { z } from 'zod';
import { loadUserLevelProfile } from '../../../leveling';
import type { BlockManifest } from '../manifest';

export const CONDITION_LEVEL_AT_LEAST = 'condition.levelAtLeast';

/** See `triggerLevelReached` for why `z.coerce`: a `text` control yields a string. */
export const levelAtLeastConfigSchema = z.object({
    level: z.coerce.number().int().min(1),
});

export type LevelAtLeastConfig = z.infer<typeof levelAtLeastConfigSchema>;

export const block: BlockManifest<LevelAtLeastConfig> = {
    type: CONDITION_LEVEL_AT_LEAST,
    kind: 'condition',
    label: 'Level At Least?',
    description: 'Split the path on how far they have climbed. Gate the good stuff behind a number.',
    group: 'conditions',
    icon: '📈',
    configSchema: levelAtLeastConfigSchema,
    configFields: [
        {
            key: 'level',
            label: 'Minimum level',
            description: 'Leave by Yes if they are at this level or above, No if they are short of it.',
            control: 'text',
            placeholder: '5',
            defaultValue: '5',
        },
    ],
    // `stopIfEmpty` so an unset level reads "no level set", not "Level ≥ no level set".
    cardSummary: [{ key: 'level', prefix: 'Level ≥ ', emptyText: 'no level set', stopIfEmpty: true }],
    handles: [
        { id: 'true', label: 'Yes', tone: 'positive' },
        { id: 'false', label: 'No', tone: 'negative' },
    ],
    outputs: [],
    requires: ['subject'],
    capabilities: [],
    canSuspend: false,
    async run(config, context) {
        /*
         * Read through the same loader the slash commands use rather than the progress
         * repo directly: it is what decides that a member with no row is level 0 rather
         * than absent, and a second opinion on that here would diverge the moment the
         * curve changed.
         */
        const profile = await loadUserLevelProfile(context.guild.id, context.subject.id);

        return {
            kind: 'continue',
            handle: profile.level >= config.level ? 'true' : 'false',
        };
    },
};
