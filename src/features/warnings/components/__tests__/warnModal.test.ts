import { describe, expect, it } from 'vitest';
import {
    WARN_DESCRIPTION_INPUT_ID,
    WARN_EXPIRES_INPUT_ID,
    WARN_ISSUED_INPUT_ID,
    WARN_MODAL_ID,
    WARN_RULE_INPUT_ID,
    WARN_USER_INPUT_ID,
    WarnModalComponent,
} from '../warnModal';

describe('WarnModalComponent', () => {
    it('uses a stable custom id and the five issue fields', () => {
        const modalJson = WarnModalComponent().buildComponent(new Date('2026-09-01T20:00:00.000Z')).toJSON();

        const serialized = JSON.stringify(modalJson);
        const fieldIds = [
            WARN_USER_INPUT_ID,
            WARN_RULE_INPUT_ID,
            WARN_DESCRIPTION_INPUT_ID,
            WARN_ISSUED_INPUT_ID,
            WARN_EXPIRES_INPUT_ID,
        ];

        expect(modalJson.custom_id).toBe(WARN_MODAL_ID);
        for (const fieldId of fieldIds) {
            expect(serialized).toContain(fieldId);
        }
    });

    it('defaults date placeholders to Pacific today and six months later', () => {
        const modalJson = WarnModalComponent().buildComponent(new Date('2026-09-01T20:00:00.000Z')).toJSON();
        const serialized = JSON.stringify(modalJson);

        expect(serialized).toContain('2026-09-01');
        expect(serialized).toContain('2027-03-01');
    });
});
