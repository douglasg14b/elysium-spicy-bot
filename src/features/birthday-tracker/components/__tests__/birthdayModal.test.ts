import { describe, expect, it } from 'vitest';
import { BirthdayModalComponent, YEAR_INPUT_ID } from '../birthdayModal';

describe('BirthdayModalComponent', () => {
    it('keeps the year field optional without a minimum length', () => {
        const modalJson = BirthdayModalComponent.buildComponent().toJSON();
        const yearInput = modalJson.components
            .flatMap((componentRow) => componentRow.components)
            .find((component) => component.custom_id === YEAR_INPUT_ID);

        expect(yearInput).toBeDefined();

        expect(yearInput?.required).toBe(false);
        expect(yearInput?.max_length).toBe(4);
        expect(yearInput?.min_length ?? 0).toBe(0);
    });
});
