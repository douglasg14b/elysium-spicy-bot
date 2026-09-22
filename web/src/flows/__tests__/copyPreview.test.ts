import { describe, expect, it } from 'vitest';
import { BUILTIN_TOKENS, builtinToken } from '../builtinTokens';
import { hasPreviewableTokens, previewCopy } from '../copyPreview';

describe('previewCopy', () => {
    it.each(BUILTIN_TOKENS.map((token) => token.name))(
        'substitutes %s for something no real value would be',
        (name) => {
            const { text, problems } = previewCopy(builtinToken(name), []);

            // Table-driven over the vocabulary itself: a token added to
            // BUILTIN_TOKENS without a stand-in surfaces here as an unknown token
            // rather than as a silently unreplaced brace in the UI.
            expect(problems).toEqual([]);
            expect(text).not.toContain('{{');
            expect(text.trim()).not.toBe('');
        }
    );

    it('leaves surrounding prose alone', () => {
        expect(previewCopy('Welcome {{subject.username}} to {{guild.name}}!', []).text).toBe(
            'Welcome someone to this server!'
        );
    });

    it('tolerates whitespace inside the braces, as the engine does', () => {
        expect(previewCopy('{{ guild.name }}', []).text).toBe('this server');
    });

    it('shows a known variable as a filled-in blank, with no complaint', () => {
        const { text, problems } = previewCopy('Ticket {{var.ticketId}}', ['ticketId']);

        expect(text).toBe('Ticket [ticketId]');
        expect(problems).toEqual([]);
    });

    it('marks a variable nothing writes rather than showing it as resolved', () => {
        // The engine fails this run as surely as it fails an unknown token, so a
        // clean `[tickteId]` would read as finished copy. The name stays visible
        // so the author can see the typo the picker is warning about underneath.
        const { text, problems } = previewCopy('Ticket {{var.tickteId}}', ['ticketId']);

        expect(text).toBe('Ticket [tickteId: nothing writes this]');
        expect(problems).toEqual([{ token: 'var.tickteId', problem: 'unwrittenVariable' }]);
    });

    it('leaves an unknown token verbatim rather than inventing a value for it', () => {
        // The braces staying visible is the message: a stand-in here would make
        // copy that fails every run look finished.
        const { text, problems } = previewCopy('Hi {{subject.nmae}}', []);

        expect(text).toBe('Hi {{subject.nmae}}');
        expect(problems).toEqual([{ token: 'subject.nmae', problem: 'unknownToken' }]);
    });

    it('treats a dotted variable name as unknown, as the engine does', () => {
        // The bag is flat, so `{{var.a.b}}` is a token the engine sees and refuses.
        // Previewing it as a blank would put the builder at odds with save-time
        // validation.
        const { text, problems } = previewCopy('{{var.a.b}}', []);

        expect(text).toBe('{{var.a.b}}');
        expect(problems).toEqual([{ token: 'var.a.b', problem: 'unknownToken' }]);
    });

    it('does not resolve an inherited property as a token', () => {
        const { problems } = previewCopy('{{toString}}', []);

        expect(problems).toEqual([{ token: 'toString', problem: 'unknownToken' }]);
    });

    it('reports a repeated mistake once', () => {
        const { problems } = previewCopy('{{nope}} and {{nope}}', []);

        expect(problems).toHaveLength(1);
    });

    it('returns copy with no tokens unchanged', () => {
        const { text, problems } = previewCopy('Just a plain title', []);

        expect(text).toBe('Just a plain title');
        expect(problems).toEqual([]);
    });
});

describe('hasPreviewableTokens', () => {
    it('is false for plain copy, so the preview adds no noise', () => {
        expect(hasPreviewableTokens('Just a plain title')).toBe(false);
    });

    it('is true once there is anything the author cannot read directly', () => {
        expect(hasPreviewableTokens('Hi {{subject.username}}')).toBe(true);
        // True even for a broken token: that is precisely when the preview has
        // something to say.
        expect(hasPreviewableTokens('Hi {{subject.nmae}}')).toBe(true);
    });
});
