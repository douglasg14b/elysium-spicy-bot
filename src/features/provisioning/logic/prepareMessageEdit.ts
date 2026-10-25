import type { ActionRowBuilder, ButtonBuilder, EmbedBuilder } from 'discord.js';
import { readMessageUploads } from '../../../features-system/guild-uploads';
import { buildMessagePayload, messageConfigSchema, type MessageAttachment } from '../../../shared/discordMessage';
import type { ResourceBindingEntity } from '../data/resourceBindingsSchema';
import { isPostedMessageRow } from './lookupBoundMessage';
import { buildButtonRows } from './messageButtons';
import { messageDigest } from './messageDrift';
import { describeMessageResourceProblem, messageResourceProblems } from './messageResourceProblems';
import type { ResourceDeclaration } from './resourceDeclaration';
import { normaliseResourceName } from './resourceName';

/**
 * What `channel.messages.edit` is handed to bring a posted message up to its declaration —
 * every member present, because Discord's PATCH leaves an absent one alone:
 *
 *  - `content` is `''` when the declaration has none, so removed text goes;
 *  - `components` is `[]` when the buttons were all removed;
 *  - `files` is always an array, and there is no `attachments` key. discord.js 14 then sends
 *    the new files' descriptors as the whole list (`MessagePayload.resolveBody`), and Discord
 *    keeps only what that list names: the old pictures are replaced rather than added to, and
 *    an empty `files` clears them. Every upload is sent again on every repair;
 *  - `allowedMentions` pings nobody, as the post does;
 *  - `flags` is no flags, sent as `flags: 0`, which clears SUPPRESS_EMBEDS — the embeds
 *    somebody hid with "Remove all embeds" show again. An empty list, because discord.js
 *    types an edit's flags as SuppressEmbeds alone and resolves `[]` to 0.
 */
export interface MessageEdit {
    readonly content: string;
    readonly embeds: EmbedBuilder[];
    readonly components: ActionRowBuilder<ButtonBuilder>[];
    readonly files: MessageAttachment[];
    readonly allowedMentions: { readonly parse: [] };
    readonly flags: readonly [];
}

/** One approved message repair, prepared before anything is sent: where it goes, what it says, and its new fingerprint. */
export interface PreparedMessageEdit {
    readonly status: 'ready';
    /** The row the fingerprint is recorded on once the edit lands. */
    readonly bindingId: number;
    readonly channelId: string;
    readonly messageId: string;
    readonly edit: MessageEdit;
    /** `messageDigest` of the declaration being written, for `recordMessageDigest`. */
    readonly digest: string;
}

/** A message repair prepared, or refused — with why, in words for the operator — before anything was touched. */
export type MessageEditPreparation = PreparedMessageEdit | { readonly status: 'refused'; readonly refusal: string };

/**
 * Prepare the edit that repairs one posted message, or refuse it with nothing touched.
 *
 * Everything that can fail short of Discord fails here, so the repair either sends one edit
 * or nothing: a declaration Discord would refuse (`messageResourceProblems`), uploads this
 * server no longer holds or that break their limits (`readMessageUploads`), a row naming no
 * post. Each refusal names the part, as install's does.
 *
 * Where the edit goes comes from the row — the message id and the channel it was posted in —
 * never from a report that travelled. Reads this guild's uploads, so it must not run inside a
 * transaction (SQLite's one connection).
 */
export async function prepareMessageEdit(
    guildId: string,
    declaration: ResourceDeclaration,
    row: ResourceBindingEntity
): Promise<MessageEditPreparation> {
    const name = normaliseResourceName('message', declaration.defaultName);

    if (!isPostedMessageRow(row) || !row.messageChannelId) {
        return { status: 'refused', refusal: `"${name}" has no record of where it was posted, so there is nothing to edit. Install it again.` };
    }
    if (!declaration.message) {
        // `validateJourneyDeclaration` requires one on every message, so this declaration skipped it.
        return { status: 'refused', refusal: `"${name}" declares nothing to post. Nothing was changed.` };
    }

    const [problem] = messageResourceProblems(declaration);
    if (problem) {
        return { status: 'refused', refusal: `${describeMessageResourceProblem(name, problem)} Fix it, then repair again — nothing was changed.` };
    }
    const parsed = messageConfigSchema.safeParse(declaration.message);
    if (!parsed.success) {
        // `messageResourceProblems` parses it first, so a failure here means the two disagree.
        throw new Error(`Message "${name}" passed messageResourceProblems but not messageConfigSchema.`);
    }

    let uploads: Awaited<ReturnType<typeof readMessageUploads>>;
    try {
        uploads = await readMessageUploads(guildId, declaration.message);
    } catch (error) {
        // The driver's words stay in the log: the operator cannot act on them.
        console.error(`[provisioning] Failed reading the uploads of message "${name}" for a repair:`, error);
        return { status: 'refused', refusal: `Couldn't read the pictures "${name}" shows. Nothing was changed; try again.` };
    }
    if (!uploads.ok) {
        return { status: 'refused', refusal: `${describeMessageResourceProblem(name, uploads.problem)} Fix it, then repair again — nothing was changed.` };
    }

    const payload = buildMessagePayload(parsed.data, uploads.files);
    return {
        status: 'ready',
        bindingId: row.id,
        channelId: row.messageChannelId,
        messageId: row.discordId,
        edit: {
            content: payload.content ?? '',
            embeds: payload.embeds,
            components: buildButtonRows(declaration.buttons ?? []),
            files: payload.files,
            allowedMentions: { parse: [] },
            flags: [],
        },
        digest: messageDigest(declaration.message, declaration.buttons),
    };
}
