import { describe, expect, it } from 'vitest';
import { MIB } from '../../byteSizes';
import { messageUploadProblems } from '../messageUploads';

const UPLOAD_A = '11111111-2222-4333-8444-555555555555';
const UPLOAD_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';

/** Problems as `path (where): message`, for one readable assertion per case. */
function problemsOf(message: unknown, held: Record<string, number>): string[] {
    return messageUploadProblems(message, new Map(Object.entries(held))).map(
        (problem) => `${problem.path.join('.')} (${problem.where ?? 'message'}): ${problem.message}`
    );
}

describe('the upload rules', () => {
    it('says nothing of a message whose uploads the server holds, or one with none', () => {
        expect(problemsOf({ embeds: [{ image: `upload:${UPLOAD_A}` }] }, { [UPLOAD_A]: 1024 })).toEqual([]);
        expect(problemsOf({ embeds: [{ image: 'https://cdn.example/a.png' }] }, {})).toEqual([]);
    });

    it('addresses an upload the server does not hold to each part showing it', () => {
        expect(
            problemsOf(
                { embeds: [{ thumbnail: `upload:${UPLOAD_A}`, footer: { text: 'f', iconUrl: `upload:${UPLOAD_A}` } }] },
                {}
            )
        ).toEqual([
            "embeds.0.thumbnail (embed 1 thumbnail): That uploaded picture isn't in this server. Pick another, or upload it again.",
            "embeds.0.footer.iconUrl (embed 1 footer icon): That uploaded picture isn't in this server. Pick another, or upload it again.",
        ]);
    });

    it('counts the bytes of each upload once, however often it is shown, and refuses over the cap', () => {
        const shownTwice = { embeds: [{ thumbnail: `upload:${UPLOAD_A}`, image: `upload:${UPLOAD_A}` }] };
        const both = { embeds: [{ thumbnail: `upload:${UPLOAD_A}`, image: `upload:${UPLOAD_B}` }] };
        const held = { [UPLOAD_A]: 6 * MIB, [UPLOAD_B]: 5 * MIB };

        expect(problemsOf(shownTwice, held)).toEqual([]);
        expect(problemsOf(both, held)).toEqual([
            ' (message): The uploaded pictures in this message come to 11.0 MB, and Discord takes 10 MB a message. ' +
                'Use smaller pictures, or fewer of them.',
        ]);
    });

    it('reads a value that is not a message as naming nothing', () => {
        expect(problemsOf('upload:' + UPLOAD_A, {})).toEqual([]);
        expect(problemsOf(undefined, {})).toEqual([]);
    });
});
