import { describe, expect, it } from 'vitest';
import {
    generateWarningSlug,
    isUniqueConstraintViolation,
    slugifyWarningRule,
    withUniqueSlugRetry,
} from '../logic/warningSlug';

describe('slugifyWarningRule', () => {
    it('turns a rule into a kebab slug', () => {
        expect(slugifyWarningRule('Consent / CNC')).toBe('consent-cnc');
    });

    it('falls back when the rule has no usable characters', () => {
        expect(slugifyWarningRule('???')).toBe('warn');
        expect(slugifyWarningRule('   ')).toBe('warn');
    });

    it('truncates long rules without a trailing hyphen', () => {
        const slug = slugifyWarningRule('a'.repeat(40) + ' ' + 'b'.repeat(10), 32);
        expect(slug.length).toBeLessThanOrEqual(32);
        expect(slug.endsWith('-')).toBe(false);
    });
});

describe('generateWarningSlug', () => {
    it('appends the provided suffix', () => {
        expect(generateWarningSlug('Consent', 'k7m2')).toBe('consent-k7m2');
    });
});

describe('isUniqueConstraintViolation', () => {
    it('detects unique constraint errors', () => {
        expect(isUniqueConstraintViolation(new Error('UNIQUE constraint failed: warnings.slug'))).toBe(
            true
        );
        expect(isUniqueConstraintViolation(new Error('duplicate key value violates unique constraint'))).toBe(
            true
        );
        expect(isUniqueConstraintViolation(new Error('something else'))).toBe(false);
        expect(isUniqueConstraintViolation('not an error')).toBe(false);
    });
});

describe('withUniqueSlugRetry', () => {
    it('returns the first successful insert', async () => {
        const inserted = await withUniqueSlugRetry(
            () => 'consent-aaaa',
            async (slug) => slug
        );

        expect(inserted).toBe('consent-aaaa');
    });

    it('retries when the slug collides then succeeds', async () => {
        const slugs = ['consent-aaaa', 'consent-bbbb'];
        let attempts = 0;

        const inserted = await withUniqueSlugRetry(
            () => slugs[attempts++] ?? 'consent-cccc',
            async (slug) => {
                if (slug === 'consent-aaaa') {
                    throw new Error('UNIQUE constraint failed');
                }

                return slug;
            }
        );

        expect(inserted).toBe('consent-bbbb');
        expect(attempts).toBe(2);
    });

    it('gives up after the last unique collision', async () => {
        await expect(
            withUniqueSlugRetry(
                () => 'consent-aaaa',
                async () => {
                    throw new Error('UNIQUE constraint failed');
                },
                { maxAttempts: 3 }
            )
        ).rejects.toThrow('UNIQUE constraint failed');
    });
});
