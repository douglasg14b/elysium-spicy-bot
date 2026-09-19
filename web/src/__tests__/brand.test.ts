import { describe, expect, it } from 'vitest';
import { brandLogoUrl, splitWordmark } from '../brand';

describe('splitWordmark', () => {
    it('accents "Bot" in the production name', () => {
        expect(splitWordmark('BrattyBot')).toEqual({ before: 'Bratty', accent: 'Bot', after: '' });
    });

    it('keeps the suffix after the accent for the dev name', () => {
        // `BrattyBot-Dev` is the real name on the dev application, so this renders
        // "Bratty" + accented "Bot" + "-Dev".
        expect(splitWordmark('BrattyBot-Dev')).toEqual({
            before: 'Bratty',
            accent: 'Bot',
            after: '-Dev',
        });
    });

    it('splits on the last "Bot" so a name containing it twice still accents the wordmark', () => {
        expect(splitWordmark('BotBrattyBot')).toEqual({
            before: 'BotBratty',
            accent: 'Bot',
            after: '',
        });
    });

    it('renders an unaccented name when there is no "Bot" to accent', () => {
        expect(splitWordmark('Brat')).toEqual({ before: 'Brat', accent: '', after: '' });
    });
});

describe('brandLogoUrl', () => {
    it('picks the dev artwork for the development flavour', () => {
        expect(brandLogoUrl('development')).toBe('/brattybot-dev-logo.png');
    });

    it('picks the production artwork for the production flavour', () => {
        expect(brandLogoUrl('production')).toBe('/brattybot-logo.png');
    });

    it('falls back to production artwork before the flavour is known', () => {
        expect(brandLogoUrl(null)).toBe('/brattybot-logo.png');
    });
});
