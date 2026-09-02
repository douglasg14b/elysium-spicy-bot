import { randomInt } from 'node:crypto';
import {
    WARNING_SLUG_BASE_MAX_LENGTH,
    WARNING_SLUG_INSERT_MAX_ATTEMPTS,
    WARNING_SLUG_SUFFIX_LENGTH,
} from '../constants';

const SLUG_SUFFIX_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

export function isUniqueConstraintViolation(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    const message = error.message.toLowerCase();
    return message.includes('unique') || message.includes('constraint');
}

export function createRandomSlugSuffix(
    length: number = WARNING_SLUG_SUFFIX_LENGTH,
    randomIndex: (max: number) => number = (max) => randomInt(max)
): string {
    let suffix = '';
    for (let index = 0; index < length; index += 1) {
        suffix += SLUG_SUFFIX_ALPHABET[randomIndex(SLUG_SUFFIX_ALPHABET.length)];
    }

    return suffix;
}

export function slugifyWarningRule(rule: string, maxLength: number = WARNING_SLUG_BASE_MAX_LENGTH): string {
    const slug = rule
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/[\s_]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');

    const truncated = (slug || 'warn').slice(0, maxLength).replace(/-+$/g, '');
    return truncated || 'warn';
}

export function generateWarningSlug(
    rule: string,
    suffix: string = createRandomSlugSuffix()
): string {
    return `${slugifyWarningRule(rule)}-${suffix}`;
}

export async function withUniqueSlugRetry<T>(
    createSlug: () => string,
    insert: (slug: string) => Promise<T>,
    options: {
        maxAttempts?: number;
        isUniqueViolation?: (error: unknown) => boolean;
    } = {}
): Promise<T> {
    const maxAttempts = options.maxAttempts ?? WARNING_SLUG_INSERT_MAX_ATTEMPTS;
    const isUniqueViolation = options.isUniqueViolation ?? isUniqueConstraintViolation;

    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const slug = createSlug();

        try {
            return await insert(slug);
        } catch (error) {
            lastError = error;
            if (!isUniqueViolation(error) || attempt === maxAttempts - 1) {
                throw error;
            }
        }
    }

    throw lastError instanceof Error ? lastError : new Error('Failed to insert warning with a unique slug');
}
