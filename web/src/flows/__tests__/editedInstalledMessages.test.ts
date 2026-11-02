import { describe, expect, it } from 'vitest';
import type { ResourceDeclaration } from '@brattybot/web-sdk';
import { editedInstalledMessageKeys } from '../editedInstalledMessages';

function panel(overrides: Partial<ResourceDeclaration> = {}): ResourceDeclaration {
    return {
        key: 'rules-panel',
        kind: 'message',
        defaultName: 'Rules panel',
        message: { embeds: [{ title: 'Rules' }] },
        buttons: [{ key: 'agree', label: 'Agree', style: 'Primary', emoji: { name: '✅' } }],
        ...overrides,
    };
}

const INSTALLED = new Set(['rules-panel']);

describe('editedInstalledMessageKeys', () => {
    it('names an installed message whose button emoji changed', () => {
        const after = panel({ buttons: [{ key: 'agree', label: 'Agree', style: 'Primary', emoji: { name: '👍' } }] });

        expect(editedInstalledMessageKeys({ before: [panel()], after: [after], installedKeys: INSTALLED })).toEqual([
            'rules-panel',
        ]);
    });

    it('names an installed message whose text changed', () => {
        const after = panel({ message: { embeds: [{ title: 'House rules' }] } });

        expect(editedInstalledMessageKeys({ before: [panel()], after: [after], installedKeys: INSTALLED })).toEqual([
            'rules-panel',
        ]);
    });

    it('is quiet when only the name changed, since the post says nothing of it', () => {
        const after = panel({ defaultName: 'Rules' });

        expect(editedInstalledMessageKeys({ before: [panel()], after: [after], installedKeys: INSTALLED })).toEqual([]);
    });

    it('is quiet for a message that is not installed: install will post it', () => {
        const after = panel({ message: { embeds: [{ title: 'House rules' }] } });

        expect(
            editedInstalledMessageKeys({ before: [panel()], after: [after], installedKeys: new Set() })
        ).toEqual([]);
    });

    it('is quiet for a message with no earlier version, and for an unchanged one', () => {
        expect(editedInstalledMessageKeys({ before: [], after: [panel()], installedKeys: INSTALLED })).toEqual([]);
        expect(editedInstalledMessageKeys({ before: [panel()], after: [panel()], installedKeys: INSTALLED })).toEqual(
            []
        );
    });

    it('reads no buttons and an empty list as the same', () => {
        const bare = panel({ buttons: undefined });
        const empty = panel({ buttons: [] });

        expect(editedInstalledMessageKeys({ before: [bare], after: [empty], installedKeys: INSTALLED })).toEqual([]);
    });
});
