import { describe, expect, it } from 'vitest';
import { isPronounRoleName } from '../pronouns';

describe('isPronounRoleName', () => {
    it.each([
        'she/her',
        'They / Them',
        'he/they',
        'xe/xem/xyr',
        '🌸 she/her',
        '[it/its]',
        'any/all',
        'She-Her',
        'she | her',
        'Any Pronouns',
        'Ask for pronouns',
        'Pronouns: she/her',
        'Neo Pronouns',
    ])('reads %s as pronouns', (name) => expect(isPronounRoleName(name)).toBe(true));

    it.each(['Dom/sub', 'Top/Bottom', 'Switch/Brat', 'Master/slave', 'Her/Majesty', 'she', 'Verified', 'DMs closed', 'Dom/me', '━━ Pronouns ━━', '──── Pronoun Roles ────'])(
        'does not read %s as pronouns',
        (name) => expect(isPronounRoleName(name)).toBe(false)
    );
});
