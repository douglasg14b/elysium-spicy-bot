import { beforeEach, describe, expect, it } from 'vitest';
import { ChatIntrosRepo } from '../chatIntrosRepo';
import type { IntroPost } from '../chatIntrosSchema';
import { chatIntrosTestDb } from './support/chatIntrosTestDb';

/** The intros copy against real SQL: edits replace text, deletes and channel changes drop posts, reads come newest first per member. */

const GUILD = 'guild-1';
const INTROS = 'intros';

function post(messageId: string, authorId: string, minute: number, content = `hi, I'm ${authorId}`, channelId = INTROS): IntroPost {
    return { messageId, guildId: GUILD, channelId, authorId, content, postedAt: new Date(Date.UTC(2026, 10, 1, 12, minute)) };
}

let repo: ChatIntrosRepo;

beforeEach(async () => {
    repo = new ChatIntrosRepo(await chatIntrosTestDb());
});

describe('ChatIntrosRepo', () => {
    it("reads a member's posts newest first, capped, dates intact, and nobody else's", async () => {
        await repo.savePosts([post('m1', 'vex', 1), post('m2', 'mara', 2), post('m3', 'vex', 3), post('m4', 'vex', 4)]);

        const found = await repo.findByAuthor(GUILD, INTROS, 'vex', 2);

        expect(found.map((intro) => intro.messageId)).toEqual(['m4', 'm3']);
        expect(found[0].postedAt).toEqual(new Date(Date.UTC(2026, 10, 1, 12, 4)));
    });

    it('takes an edit as the new text of the same post', async () => {
        await repo.savePosts([post('m1', 'vex', 1, 'first draft')]);
        await repo.savePosts([post('m1', 'vex', 1, 'second draft')]);

        expect((await repo.findByAuthor(GUILD, INTROS, 'vex', 5)).map((intro) => intro.content)).toEqual(['second draft']);
    });

    it('drops deleted posts, and everything from another channel once the intros channel moves', async () => {
        await repo.savePosts([post('m1', 'vex', 1), post('m2', 'vex', 2), post('old', 'vex', 3, 'hi', 'old-intros')]);

        await repo.deletePosts(GUILD, ['m1']);
        await repo.deleteOutsideChannel(GUILD, INTROS);

        expect(await repo.listMessageIds(GUILD, INTROS)).toEqual(['m2']);
        expect(await repo.listMessageIds(GUILD, 'old-intros')).toEqual([]);

        await repo.deleteOutsideChannel(GUILD, null);
        expect(await repo.listMessageIds(GUILD, INTROS)).toEqual([]);
    });
});
