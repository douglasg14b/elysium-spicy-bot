import { describe, expect, it } from 'vitest';
import { buildWarningEditedNoticeEmbed, buildWarningReleasedNoticeEmbed } from '../logic/warningChangeNotices';
import { buildWarningIssuedNoticeEmbed } from '../logic/warningIssuedNotice';
import { EMBED_FIELD_VALUE_MAX } from '../logic/warningNotice';
import { sampleWarning } from './support/sampleWarning';

function fieldsOf(embed: { toJSON: () => { fields?: { name: string; value: string }[] } }) {
    return Object.fromEntries((embed.toJSON().fields ?? []).map((field) => [field.name, field.value]));
}

function releasedWarning() {
    return sampleWarning({
        clearedAt: new Date('2026-09-02T12:00:00.000Z'),
        clearedById: 'mod-2',
        clearedByName: 'Mistress',
        clearReason: 'Apologised on their knees.',
    });
}

describe('buildWarningReleasedNoticeEmbed', () => {
    it('names the member, who released it, the rule, the slug and the reason, from the saved row', () => {
        const embed = buildWarningReleasedNoticeEmbed(releasedWarning());

        expect(embed.toJSON().title).toBe('Warning released');
        expect(fieldsOf(embed)).toEqual({
            Member: '<@user-1>',
            'Released by': '<@mod-2>',
            Rule: 'Consent',
            Slug: '`consent-k7m2`',
            Reason: 'Apologised on their knees.',
        });
    });

    it('refuses a row that records no release', () => {
        expect(() => buildWarningReleasedNoticeEmbed(sampleWarning())).toThrow(/no releaser or reason/);
    });

    it('wears the issued notice colour and footer', () => {
        const released = buildWarningReleasedNoticeEmbed(releasedWarning()).toJSON();
        const issued = buildWarningIssuedNoticeEmbed({ warning: sampleWarning(), activeCount: 1 }).toJSON();

        expect(released.color).toBe(issued.color);
        expect(released.footer).toEqual(issued.footer);
    });
});

describe('buildWarningEditedNoticeEmbed', () => {
    it('lists only the changed fields, each as before → after', () => {
        const embed = buildWarningEditedNoticeEmbed({
            warning: sampleWarning(),
            editedBy: { id: 'mod-2', name: 'Mistress' },
            changes: [
                { field: 'rule', before: 'Consent', after: 'Privacy' },
                { field: 'dropsOffOn', before: '2027-03-01', after: '2027-06-01' },
            ],
        });

        expect(embed.toJSON().title).toBe('Warning edited');
        expect(fieldsOf(embed)).toEqual({
            Member: '<@user-1>',
            'Edited by': '<@mod-2>',
            Slug: '`consent-k7m2`',
            Rule: 'Consent → Privacy',
            'Drop-off': '2027-03-01 → 2027-06-01',
        });
    });

    it('keeps two full-length descriptions whole, one field each', () => {
        const before = 'b'.repeat(1000);
        const after = 'a'.repeat(1000);
        const embed = buildWarningEditedNoticeEmbed({
            warning: sampleWarning(),
            editedBy: { id: 'mod-2', name: 'Mistress' },
            changes: [{ field: 'description', before, after }],
        });

        const fields = fieldsOf(embed);
        expect(fields['Description (before)']).toBe(before);
        expect(fields['Description (after)']).toBe(after);
        expect(Math.max(before.length, after.length)).toBeLessThanOrEqual(EMBED_FIELD_VALUE_MAX);
    });
});
