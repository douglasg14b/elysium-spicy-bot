import type { UnpublishedResource } from '@brattybot/web-sdk';
import { describe, expect, it } from 'vitest';
import { uninstallNotice } from '../uninstallNotice';

function result(overrides: Partial<UnpublishedResource>): UnpublishedResource {
    return { resourceKey: 'rules', kind: 'textChannel', name: 'rules', outcome: 'deleted', ...overrides };
}

describe('uninstallNotice', () => {
    it('calls a run uninstalled when everything went, or was kept as the plan said it would be', () => {
        const notice = uninstallNotice(
            [result({}), result({ resourceKey: 'lobby', outcome: 'refused', explanation: 'Adopted.' })],
            new Set(['lobby'])
        );

        expect(notice).toMatchObject({ color: 'brand', title: 'Uninstalled' });
        expect(notice.message).toMatch(/^1 thing deleted from the server\./);
    });

    it('calls it partly done when a message was left up that the plan meant to delete — posted again meanwhile', () => {
        const notice = uninstallNotice(
            [
                result({}),
                result({
                    resourceKey: 'rules-panel',
                    kind: 'message',
                    name: 'Rules panel',
                    outcome: 'refused',
                    explanation: 'Posted again meanwhile; left as it stands.',
                }),
            ],
            new Set()
        );

        expect(notice).toEqual({
            color: 'orange',
            title: 'Partly done',
            message: '1 deleted; 1 left in place: Posted again meanwhile; left as it stands.',
        });
    });

    it('calls it partly done when Discord refused one', () => {
        const notice = uninstallNotice([result({ outcome: 'failed', explanation: 'Missing Access.' })], new Set());

        expect(notice).toMatchObject({ title: 'Partly done', message: '0 deleted; 1 left in place: Missing Access.' });
    });
});
