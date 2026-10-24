import { describe, expect, it } from 'vitest';
import { parsePictureRef, pictureRefSchema, renderedPictureProblem } from '../pictureRef';

const UPLOAD_ID = 'abcdef12-2222-4333-8444-5555555555ee';

describe('parsePictureRef', () => {
    it('reads an upload ref, a link, and text holding a token', () => {
        expect(parsePictureRef(`upload:${UPLOAD_ID}`)).toEqual({ kind: 'upload', uploadId: UPLOAD_ID });
        expect(parsePictureRef('https://cdn.example/a.png')).toEqual({ kind: 'link', url: 'https://cdn.example/a.png' });
        expect(parsePictureRef('http://cdn.example/a.png')).toEqual({ kind: 'link', url: 'http://cdn.example/a.png' });
        // A phone keyboard capitalises the scheme; Discord does not care.
        expect(parsePictureRef('Https://cdn.example/a.png')?.kind).toBe('link');
        expect(parsePictureRef('HTTPS://CDN.EXAMPLE/A.PNG')?.kind).toBe('link');
        expect(parsePictureRef('{{subject.avatarUrl}}')).toEqual({ kind: 'token', text: '{{subject.avatarUrl}}' });
    });

    it('reads a link with a token inside it as a token, judged once it is filled in', () => {
        expect(parsePictureRef('https://cdn.example/{{var.pic}}.png')?.kind).toBe('token');
        expect(parsePictureRef('{{ subject.avatarUrl }}')?.kind).toBe('token');
        expect(parsePictureRef('{subject.avatarUrl}')).toBeUndefined();
    });

    it('reads nothing else as a picture', () => {
        for (const value of [
            '',
            'a picture',
            'ftp://cdn.example/a.png',
            'https://',
            'https://cdn.example/a b.png',
            // The pattern takes these; the URL parser, and so the embed builder, does not.
            'https://a%zz/x.png',
            'https://[x/a.png',
            'upload:not-a-uuid',
            `upload:${UPLOAD_ID.toUpperCase()}`,
            ` upload:${UPLOAD_ID}`,
            '{{ unclosed',
        ]) {
            expect(parsePictureRef(value), value).toBeUndefined();
        }
    });

});

describe('pictureRefSchema', () => {
    it('takes an upload, a link or a token, and refuses anything else in the product voice', () => {
        expect(pictureRefSchema.safeParse(`upload:${UPLOAD_ID}`).success).toBe(true);
        expect(pictureRefSchema.safeParse('https://cdn.example/a.png').success).toBe(true);
        expect(pictureRefSchema.safeParse('{{subject.avatarUrl}}').success).toBe(true);
        expect(pictureRefSchema.safeParse('a cute picture').error?.issues[0]?.message).toBe(
            'A picture takes an upload, a full http:// or https:// link, or a token like {{subject.avatarUrl}}.'
        );
    });
});

describe('renderedPictureProblem', () => {
    it('passes a link, and a part left out', () => {
        expect(renderedPictureProblem('"Message" embed 1 image', 'https://cdn.example/a.png')).toBeUndefined();
        expect(renderedPictureProblem('"Message" embed 1 image', undefined)).toBeUndefined();
    });

    it('names the part and what it came out as when a token filled in something else', () => {
        expect(renderedPictureProblem('"Message" embed 1 image', 'Bob')).toMatch(
            /^"Message" embed 1 image came out as "Bob" once its tokens were filled in, which is not a link/
        );
        expect(renderedPictureProblem('"Message" embed 1 image', 'https://a%zz/x.png')).toBeDefined();
    });
});
