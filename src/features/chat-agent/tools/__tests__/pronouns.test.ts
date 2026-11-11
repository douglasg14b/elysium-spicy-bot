import { describe, expect, it } from 'vitest';
import { isPronounRoleName } from '../pronouns';

describe('isPronounRoleName', () => {
    it.each(['she/her', 'They / Them', 'he/they', 'xe/xem/xyr', '🌸 she/her', '[it/its]', 'any/all', 'Any Pronouns', 'Ask for pronouns', 'Pronouns: she/her'])(
        'reads %s as pronouns',
        (name) => expect(isPronounRoleName(name)).toBe(true)
    );

    it.each(['Dom/sub', 'Top/Bottom', 'Switch/Brat', 'Master/slave', 'she', 'Verified', 'DMs closed', 'Dom/me'])('does not read %s as pronouns', (name) =>
        expect(isPronounRoleName(name)).toBe(false)
    );
});
