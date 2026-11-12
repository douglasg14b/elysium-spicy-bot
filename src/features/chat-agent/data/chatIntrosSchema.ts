import type { ColumnType } from 'kysely';

/**
 * One member's post in their server's intros channel, copied so `getMemberIntro` reads it from
 * the database rather than paging the channel. Kept by `intros/introsSync.ts`: every post as it
 * lands, is edited or deleted, and the whole channel again at startup and when the channel
 * changes. Only the configured channel's posts are held; a server with none holds none.
 *
 * The text is as Discord sent it — `<#id>`, `<@id>` and all — so a channel it names is judged
 * against whoever reads it, at the time they read it.
 */
export interface ChatAgentIntrosTable {
    /** The Discord message: edits and deletes arrive naming it. */
    messageId: string;
    guildId: string;
    channelId: string;
    authorId: string;
    content: string;
    postedAt: ColumnType<Date, string, string>;
}

/** An intro post as the repo writes and reads it. */
export type IntroPost = {
    readonly messageId: string;
    readonly guildId: string;
    readonly channelId: string;
    readonly authorId: string;
    readonly content: string;
    readonly postedAt: Date;
};
