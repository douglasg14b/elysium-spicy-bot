/**
 * What every part on the stage reads from the window: the message, the way to change it, the
 * mode, and the page's variables and uploads — one context rather than the same seven props
 * passed down through every embed and field.
 */

import { createContext, useContext } from 'react';
import type { ButtonListener, MessageButton } from '@brattybot/web-sdk';
import type { GuildUploads } from '../controls/types';
import type { AvailableVariable, RequirementAvailability } from '../variables';
import type { MessageDraft } from './messageDraft';
import type { PlacedMessageIssues } from './messageIssues';

/** Edit draws every part as something to click; Preview draws only what will be posted, tokens filled in. */
export type EditorMode = 'edit' | 'preview';

export interface EditorScope {
    readonly mode: EditorMode;
    readonly message: MessageDraft;
    /**
     * Change the message: `edit` is handed the **latest** message, not the one this render
     * saw, so an upload that answers after other edits lands on top of them rather than
     * undoing them.
     */
    readonly apply: (edit: (message: MessageDraft) => MessageDraft) => void;
    /** The path of the text part being typed into, or `null`. */
    readonly editing: string | null;
    readonly setEditing: (path: string | null) => void;
    /**
     * Whether an upload is on its way. An upload lands on the embed at the position it was
     * sent for, so moving, duplicating and deleting embeds waits for it — said by dimming
     * those tools, never by disabling anything.
     */
    readonly uploading: boolean;
    /** Count `work` as an upload on its way until it settles; resolves as it does. */
    readonly trackUpload: <TResult>(work: Promise<TResult>) => Promise<TResult>;
    readonly issues: PlacedMessageIssues;
    readonly variables: readonly AvailableVariable[];
    readonly requirements: RequirementAvailability;
    readonly uploads: GuildUploads;
    /** The colours the block offers; the first one colours a new embed. */
    readonly swatches: readonly string[];
    /**
     * Whether the message takes `{{tokens}}`. A message no run posts — a message resource —
     * has nobody to fill one in, so it offers no `{x}` and no picture Token tab.
     */
    readonly tokens: boolean;
    /** The buttons under the message, for one that has them; `undefined` draws no button row. */
    readonly buttons: EditorButtons | undefined;
}

/** A message's buttons as the window edits them. */
export interface EditorButtons {
    readonly value: readonly MessageButton[];
    /** Every edit, at once. */
    readonly onChange: (next: MessageButton[]) => void;
    /** What is wrong with each button, by position; a complaint about the whole list under `-1`. */
    readonly issues?: ReadonlyMap<number, readonly string[]>;
    /**
     * The Button Click triggers listening to this message's buttons. A listened button names
     * its flow under it, its key is locked — a press is routed by it — and removing it asks.
     */
    readonly listeners: readonly ButtonListener[];
}

export const EditorScopeContext = createContext<EditorScope | null>(null);

export function useEditorScope(): EditorScope {
    const scope = useContext(EditorScopeContext);
    if (!scope) throw new Error('A message part was drawn outside the message window.');
    return scope;
}
