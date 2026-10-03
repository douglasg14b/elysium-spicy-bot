import { z } from 'zod';
import type { BlockManifest } from '../../../../../blocks/manifest';
import { VARIABLE_NAME_MESSAGE, VARIABLE_NAME_SHAPE } from '../../../../../blocks/variableName';

/**
 * A condition reading a time variable by name — `variableSelect`'s and
 * `warnIfUnconnected`'s proof, until a shipped block declares either.
 *
 * Three exits, the third marked as one worth a warning when left unconnected. A test
 * spies on `run` to see the executor handed it the bare name, untouched, rather than
 * resolving it the way it resolves a picker's token.
 */
export const FIXTURE_READ_TIME = 'fixture.readTime';

/** The time variable `run` records on Yes. */
export const CHECKED_AT = 'checkedAt';

export const readTimeConfigSchema = z.object({
    timeVariable: z.string().regex(VARIABLE_NAME_SHAPE, VARIABLE_NAME_MESSAGE).optional(),
});

export type ReadTimeConfig = z.infer<typeof readTimeConfigSchema>;

export const block: BlockManifest<ReadTimeConfig> = {
    type: FIXTURE_READ_TIME,
    kind: 'condition',
    label: 'Read Time',
    description: 'Checks whether a saved time exists. Test fixture, not for a palette.',
    group: 'conditions',
    icon: '⌛',
    configSchema: readTimeConfigSchema,
    configFields: [{ key: 'timeVariable', label: 'Saved time', control: 'variableSelect', valueKind: 'time' }],
    cardSummary: [{ key: 'timeVariable', emptyText: 'no time picked' }],
    handles: [
        { id: 'true', label: 'Yes', tone: 'positive' },
        { id: 'false', label: 'No', tone: 'negative' },
        { id: 'noRecord', label: 'No record', tone: 'caution', warnIfUnconnected: true },
    ],
    // Written on Yes only, so a test can prove a value scoped to one exit is offered —
    // and accepted at save — only on paths leaving by that exit.
    outputs: [{ naming: 'fixed', key: CHECKED_AT, label: 'When it checked', valueKind: 'time', handle: 'true' }],
    requires: [],
    capabilities: [],
    canSuspend: false,
    run(config, context) {
        const name = config.timeVariable;
        const value = name && Object.hasOwn(context.variables, name) ? context.variables[name] : undefined;
        if (value === undefined || value === null || value === '') {
            return { kind: 'continue', handle: 'noRecord' };
        }
        context.setOutput(CHECKED_AT, new Date().toISOString());
        return { kind: 'continue', handle: 'true' };
    },
};
