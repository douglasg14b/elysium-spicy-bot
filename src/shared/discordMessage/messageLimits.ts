import { MIB } from '../byteSizes';

/**
 * Discord's own limits on a message and its embeds, in characters unless named otherwise.
 *
 * Held by the schema rather than trusted: Discord refuses the whole message when any one of
 * these is over, so an author who pastes an essay would otherwise find out from a failed run
 * rather than from a save they can fix while looking at the part.
 *
 * `totalCharacters`, `uploadBytes` and `attachments` span parts, so no single part's rule can
 * state them — `messageProblems` and `messageUploadProblems` judge them, at save and again
 * once the copy is rendered and the uploads are read.
 */
export const MESSAGE_LIMITS = {
    /** The plain text above the embeds. */
    content: 2000,
    embeds: 10,
    title: 256,
    description: 4096,
    fields: 25,
    fieldName: 256,
    fieldValue: 1024,
    footerText: 2048,
    authorName: 256,
    /**
     * Every embed's title, description, field names and values, footer text and author name,
     * summed across the whole message. Discord counts these together and refuses the message
     * when they exceed this, however comfortably each fits on its own.
     */
    totalCharacters: 6000,
    /**
     * The most bytes of uploaded pictures one message may carry.
     *
     * Discord's bot upload limit is believed to be 10 MiB on an unboosted server, but whether
     * that applies per file or per message is not settled, so this takes the stricter reading:
     * every upload a message attaches, counted together. Measured on a live guild before it is
     * trusted further (the step's slice E).
     */
    uploadBytes: 10 * MIB,
    /** The most files one message may carry — each distinct upload it shows is one. */
    attachments: 10,
} as const;
