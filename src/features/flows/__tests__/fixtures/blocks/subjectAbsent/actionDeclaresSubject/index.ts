import { z } from 'zod';
import type { BlockManifest } from '../../../../../blocks/manifest';

/**
 * An action that declares `subject` and never reads it — so the only thing that can stop
 * it running on a run about nobody is the executor's requirement check. With the check
 * the run fails by name; without it the run completes, which is what makes that check
 * sabotage-verifiable (a shipped block would fail either way, through `requireSubject`).
 */
export const FIXTURE_ACTION_DECLARES_SUBJECT = 'fixture.actionDeclaresSubject';

export const actionDeclaresSubjectConfigSchema = z.object({});

export type ActionDeclaresSubjectConfig = z.infer<typeof actionDeclaresSubjectConfigSchema>;

export const block: BlockManifest<ActionDeclaresSubjectConfig> = {
    type: FIXTURE_ACTION_DECLARES_SUBJECT,
    kind: 'action',
    label: 'Declares Subject',
    description: 'Needs a member on paper, reads none. Test fixture, not for a palette.',
    group: 'actions',
    icon: '🧾',
    configSchema: actionDeclaresSubjectConfigSchema,
    configFields: [],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: ['subject'],
    capabilities: [],
    canSuspend: false,
    run() {
        return { kind: 'continue' };
    },
};
