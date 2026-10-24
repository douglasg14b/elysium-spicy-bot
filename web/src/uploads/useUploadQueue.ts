/**
 * Several pictures dropped at once, sent one after another, each with its own state.
 *
 * One at a time because the server keeps a server's uploads one at a time anyway, and a
 * person watching a batch reads it top to bottom. A file dropped while a batch is going joins
 * its end rather than starting a second run beside it.
 *
 * Each upload goes through {@link keepGuildUpload}, the builder's own, so the server's list
 * in the cache — the one this page and the builder's picture box both read — gains each
 * picture as it lands; once the run ends the list is asked for again, so the meter and every
 * card are the server's word rather than a sum the page kept.
 *
 * Leaving the page (or switching servers) stops the batch: the picture on its way finishes,
 * since it cannot be called back, and the ones still waiting are never sent — nobody would be
 * left to see whether they were kept.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { listGuildUploadsQueryKey } from '@brattybot/web-sdk';
import { keepGuildUpload, uploadRefusalSentence } from './keepGuildUpload';

/** Where one file in the batch has got to. */
export type QueuedUploadState =
    | { readonly kind: 'waiting' }
    | { readonly kind: 'sending' }
    /** Kept as a new picture. */
    | { readonly kind: 'kept' }
    /** The server already held these exact bytes, under the name `keptAs`. */
    | { readonly kind: 'alreadyHeld'; readonly keptAs: string }
    /** Not kept, in the server's words (or the browser's, for one too big to send). */
    | { readonly kind: 'refused'; readonly sentence: string };

export interface QueuedUpload {
    readonly id: number;
    readonly fileName: string;
    readonly state: QueuedUploadState;
}

export interface UploadQueue {
    readonly entries: readonly QueuedUpload[];
    /** Whether any file is still waiting or on its way. */
    readonly busy: boolean;
    /** Add files to the end of the batch, and start it if it is not running. */
    readonly add: (files: readonly File[]) => void;
    /**
     * Forget every file that has finished; one still waiting or on its way stays. Says whether
     * the list is now empty.
     */
    readonly clearFinished: () => boolean;
}

function finished(state: QueuedUploadState): boolean {
    return state.kind !== 'waiting' && state.kind !== 'sending';
}

export function useUploadQueue(guildId: string): UploadQueue {
    const queryClient = useQueryClient();
    const [entries, setEntries] = useState<readonly QueuedUpload[]>([]);
    // Read and written outside renders: a second drop can land before a render has caught up.
    const waiting = useRef<{ readonly id: number; readonly file: File }[]>([]);
    const running = useRef(false);
    const alive = useRef(true);
    const nextId = useRef(1);

    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            waiting.current = [];
        };
    }, []);

    const settle = useCallback((id: number, state: QueuedUploadState) => {
        setEntries((current) => current.map((entry) => (entry.id === id ? { ...entry, state } : entry)));
    }, []);

    const send = useCallback(
        async (file: File): Promise<QueuedUploadState> => {
            try {
                const { upload, created } = await keepGuildUpload(queryClient, guildId, file);
                return created ? { kind: 'kept' } : { kind: 'alreadyHeld', keptAs: upload.fileName };
            } catch (error) {
                return { kind: 'refused', sentence: uploadRefusalSentence(error) };
            }
        },
        [guildId, queryClient]
    );

    const run = useCallback(async () => {
        if (running.current) return;
        running.current = true;
        try {
            for (let next = waiting.current.shift(); next && alive.current; next = waiting.current.shift()) {
                settle(next.id, { kind: 'sending' });
                settle(next.id, await send(next.file));
            }
        } finally {
            running.current = false;
        }
        void queryClient.invalidateQueries({ queryKey: listGuildUploadsQueryKey({ path: { guildId } }) });
    }, [guildId, queryClient, send, settle]);

    const add = useCallback(
        (files: readonly File[]) => {
            if (files.length === 0 || !alive.current) return;
            const added = files.map((file) => {
                const id = nextId.current;
                nextId.current += 1;
                return { id, file };
            });
            setEntries((current) => [
                ...current,
                ...added.map(({ id, file }): QueuedUpload => ({ id, fileName: file.name, state: { kind: 'waiting' } })),
            ]);
            waiting.current.push(...added);
            void run();
        },
        [run]
    );

    const clearFinished = useCallback((): boolean => {
        setEntries((current) => current.filter((entry) => !finished(entry.state)));
        return entries.every((entry) => finished(entry.state));
    }, [entries]);

    return { entries, busy: entries.some((entry) => !finished(entry.state)), add, clearFinished };
}
