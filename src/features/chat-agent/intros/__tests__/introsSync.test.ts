import { ChannelType, Collection, MessageType, type Guild, type Message } from 'discord.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChatIntrosRepo } from '../../data/chatIntrosRepo';
import { chatIntrosTestDb } from '../../data/__tests__/support/chatIntrosTestDb';
import { isIntroPost, noteLiveWrite, rescanIntros } from '../introsSync';

const GUILD = 'guild-1';
const INTROS = 'intros';

type FakePost = { id: string; author: string; content?: string; bot?: boolean; type?: MessageType };

function message({ id, author, content = `hi, I'm ${author}`, bot = false, type = MessageType.Default }: FakePost): Message<true> {
    return {
        id,
        guildId: GUILD,
        channelId: INTROS,
        author: { id: author, bot },
        system: false,
        type,
        content,
        createdAt: new Date(Date.UTC(2026, 10, 1, 12, Number(id.replace(/\D/g, '')) % 60)),
        inGuild: () => true,
    } as unknown as Message<true>;
}

/**
 * A guild whose intros channel holds `posts`, newest first, paged as Discord pages: 100 at most,
 * before an id. `whileFetching` runs as each page is fetched, as a live event landing mid-rescan would.
 */
function guildWith(posts: readonly FakePost[], whileFetching: (page: number) => Promise<void> = async () => undefined) {
    const pagesFetched: (string | undefined)[] = [];
    const messages = posts.map(message);
    const channel = {
        id: INTROS,
        type: ChannelType.GuildText,
        permissionsFor: () => ({ has: () => true }),
        messages: {
            fetch: async ({ limit, before }: { limit: number; before?: string }) => {
                await whileFetching(pagesFetched.length);
                pagesFetched.push(before);
                const start = before ? messages.findIndex((candidate) => candidate.id === before) + 1 : 0;
                return new Collection(messages.slice(start, start + limit).map((candidate) => [candidate.id, candidate]));
            },
        },
    };
    const guild = { id: GUILD, members: { me: { id: 'bot' } }, channels: { cache: new Map([[INTROS, channel]]) } } as unknown as Guild;
    return { guild, pagesFetched };
}

/** `count` intros, newest first: `m{count}` … `m1`. */
function manyPosts(count: number): FakePost[] {
    return Array.from({ length: count }, (_unused, index) => ({ id: `m${count - index}`, author: `member-${count - index}` }));
}

let repo: ChatIntrosRepo;

beforeEach(async () => {
    repo = new ChatIntrosRepo(await chatIntrosTestDb());
});

describe('isIntroPost', () => {
    it("takes a member's own post with text, and not a bot's, a reply or a picture alone", () => {
        expect(isIntroPost(message({ id: 'm1', author: 'vex' }))).toBe(true);
        expect(isIntroPost(message({ id: 'm2', author: 'brattybot', bot: true }))).toBe(false);
        expect(isIntroPost(message({ id: 'm3', author: 'mara', type: MessageType.Reply, content: 'welcome!' }))).toBe(false);
        expect(isIntroPost(message({ id: 'm4', author: 'vex', content: '  ' }))).toBe(false);
    });
});

describe('rescanIntros', () => {
    it('copies the whole channel a page at a time, and drops posts deleted while the bot was away', async () => {
        await repo.savePosts([{ messageId: 'gone', guildId: GUILD, channelId: INTROS, authorId: 'old', content: 'bye', postedAt: new Date() }]);
        const { guild, pagesFetched } = guildWith([...manyPosts(150), { id: 'm0', author: 'bot-1', bot: true }]);

        await rescanIntros(guild, INTROS, repo, () => true);

        expect(pagesFetched).toEqual([undefined, 'm51']);
        const held = await repo.listMessageIds(GUILD, INTROS);
        expect(held).toHaveLength(150);
        expect(held).not.toContain('gone');
        expect(held).not.toContain('m0');
    });

    it('leaves what the live listeners wrote meanwhile: a post that landed mid-scan is kept, one deleted mid-scan stays deleted', async () => {
        const { guild } = guildWith(manyPosts(150), async (page) => {
            if (page !== 1) return;
            // Between the pages: a new intro arrives (newer than page 0, so on no page), and m40 is deleted — on page 1, whose fetch still has it.
            noteLiveWrite(GUILD, ['new']);
            await repo.savePosts([{ messageId: 'new', guildId: GUILD, channelId: INTROS, authorId: 'newbie', content: 'hi!', postedAt: new Date() }]);
            noteLiveWrite(GUILD, ['m40']);
            await repo.deletePosts(GUILD, ['m40']);
        });

        await rescanIntros(guild, INTROS, repo, () => true);

        const held = await repo.listMessageIds(GUILD, INTROS);
        expect(held).toContain('new');
        expect(held).not.toContain('m40');
        expect(held).toHaveLength(150);
    });

    it('stops once the channel is no longer the saved one, leaving the rest to the next rescan', async () => {
        const { guild, pagesFetched } = guildWith(manyPosts(150));
        let pages = 0;

        await rescanIntros(guild, INTROS, repo, () => pages++ < 1);

        expect(pagesFetched).toEqual([undefined]);
        expect(await repo.listMessageIds(GUILD, INTROS)).toHaveLength(100);
    });

    it('drops the whole copy when the intros channel is cleared, reading nothing', async () => {
        await repo.savePosts([{ messageId: 'm1', guildId: GUILD, channelId: INTROS, authorId: 'vex', content: 'hi', postedAt: new Date() }]);
        const { guild, pagesFetched } = guildWith(manyPosts(3));

        await rescanIntros(guild, null, repo, () => true);

        expect(pagesFetched).toEqual([]);
        expect(await repo.listMessageIds(GUILD, INTROS)).toEqual([]);
    });
});
