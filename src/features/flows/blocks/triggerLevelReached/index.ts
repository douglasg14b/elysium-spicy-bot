import { z } from 'zod';
import type { BlockManifest } from '../manifest';

export const TRIGGER_LEVEL_REACHED = 'trigger.levelReached';

/**
 * The variable names this trigger's run seed carries, owned here rather than at the
 * dispatcher.
 *
 * The dispatcher supplies the *values* — it is the only thing that sees the event — but
 * naming them is this block's business: these keys are what `outputs` below declares, so
 * a name written in two places could disagree and leave `{{var.level}}` resolving to
 * nothing while the picker still offered it.
 *
 * It also keeps `engine/levelUpDispatch.ts` free of leveling nouns, which
 * `__tests__/engineVocabulary.test.ts` requires of everything under `engine/` — a block
 * directory is the sanctioned home for a domain word, the interpreter is not.
 */
export const LEVEL_REACHED_VARIABLES = {
    level: 'level',
    totalXp: 'totalXp',
} as const;

/**
 * Fires when a member crosses into a level.
 *
 * `z.coerce.number()` rather than `z.number()`: a `text` control hands its value over as
 * a string, and conformance rejects a numeric field whose schema cannot take one.
 *
 * `min(1)` because level 0 is where everyone starts — a trigger on it would fire for a
 * member who has done nothing, which is not a thing that happens and not a thing an
 * author means.
 */
export const levelReachedConfigSchema = z.object({
    level: z.coerce.number().int().min(1),
});

export type LevelReachedConfig = z.infer<typeof levelReachedConfigSchema>;

export const block: BlockManifest<LevelReachedConfig> = {
    type: TRIGGER_LEVEL_REACHED,
    kind: 'trigger',
    label: 'Reaches Level',
    description: 'Start the run when someone levels up into the number you name. Reward the grind.',
    group: 'triggers',
    icon: '🏆',
    configSchema: levelReachedConfigSchema,
    configFields: [
        {
            key: 'level',
            label: 'Level',
            description:
                'Fires the moment they reach exactly this level. Someone who jumps two levels at once sets off both.',
            control: 'text',
            placeholder: '10',
            defaultValue: '10',
        },
    ],
    // `stopIfEmpty` so an unset level reads "no level set", not "Reaches level no level set".
    cardSummary: [{ key: 'level', prefix: 'Reaches level ', emptyText: 'no level set', stopIfEmpty: true }],
    note: 'Levels earned by a flow awarding XP do not set this off — only XP earned from chatting, reacting and voice. That is deliberate: two flows feeding each other would never settle.',
    handles: [{ label: 'Then', tone: 'neutral' }],
    /*
     * The first trigger in the repo to declare outputs.
     *
     * `fixed` rather than `authored`: the dispatcher writes these, not the author, so
     * there is no field to read a name from. The names are flat and shared across the
     * run's variable bag, hence the `level`/`totalXp` prefix-free names matching what a
     * reader of `{{var.level}}` would expect.
     */
    outputs: [
        {
            naming: 'fixed',
            key: LEVEL_REACHED_VARIABLES.level,
            label: 'Level reached',
            description: 'The level they just hit.',
        },
        {
            naming: 'fixed',
            key: LEVEL_REACHED_VARIABLES.totalXp,
            label: 'Total XP',
            description: 'Their lifetime XP at the moment they levelled up.',
        },
    ],
    // No `channel`: levelling up happens nowhere in particular, same as a join.
    requires: ['subject', 'actor'],
    capabilities: [],
    startedBy: 'levelUp',
    canSuspend: false,
    run() {
        return { kind: 'continue' };
    },
};
