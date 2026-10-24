/**
 * Where pictures go in: drop several at once, or browse for them.
 *
 * Never `disabled`, and never blocked while a batch is sending: another drop joins the end
 * of the batch (`useUploadQueue`). Disabling it would steal focus from "browse" mid-batch.
 */

import { useRef, useState, type DragEvent, type RefObject } from 'react';
import { Anchor, Box, FileButton, Group, Text } from '@mantine/core';
import { IconUpload } from '@tabler/icons-react';
import { UPLOAD_SIZE_LABEL } from './uploadLimits';
import { ACCEPTED_UPLOAD_TYPES, UPLOAD_TYPES_HINT } from './uploadTypes';

interface UploadDropZoneProps {
    readonly onFiles: (files: readonly File[]) => void;
    /** "browse", for the page to move focus to once there is nothing left above it to focus. */
    readonly browseRef: RefObject<HTMLButtonElement>;
}

export function UploadDropZone({ onFiles, browseRef }: UploadDropZoneProps) {
    const [over, setOver] = useState(false);
    const resetChooser = useRef<() => void>(null);

    const dropped = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setOver(false);
        onFiles(Array.from(event.dataTransfer.files));
    };

    return (
        <Box
            role="group"
            aria-label="Drop pictures here"
            onDragOver={(event) => {
                event.preventDefault();
                setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={dropped}
            px={16}
            py={10}
            style={{
                border: `1.5px dashed var(--mantine-color-${over ? 'brand-4' : 'dark-4'})`,
                borderRadius: 'var(--mantine-radius-md)',
                background: over ? 'rgba(0,162,255,.1)' : 'rgba(0,162,255,.03)',
            }}
        >
            <Group gap={10} wrap="nowrap">
                <IconUpload size={18} color="var(--mantine-color-brand-4)" style={{ flex: 'none' }} />
                <div>
                    <Text size="13px" c="dark.1" lh={1.45}>
                        <b>Drop pictures here</b> or{' '}
                        <FileButton
                            multiple
                            accept={ACCEPTED_UPLOAD_TYPES}
                            resetRef={resetChooser}
                            onChange={(files) => {
                                onFiles(files);
                                // So picking the same files again is a change the chooser reports.
                                resetChooser.current?.();
                            }}
                            inputProps={{ 'aria-label': 'Upload pictures' }}
                        >
                            {(props) => (
                                <Anchor ref={browseRef} component="button" type="button" size="13px" fw={700} c="brand.4" {...props}>
                                    browse
                                </Anchor>
                            )}
                        </FileButton>
                    </Text>
                    <Text size="11.5px" c="dark.3" lh={1.45}>
                        {UPLOAD_TYPES_HINT} · up to {UPLOAD_SIZE_LABEL} each
                    </Text>
                </div>
            </Group>
        </Box>
    );
}
