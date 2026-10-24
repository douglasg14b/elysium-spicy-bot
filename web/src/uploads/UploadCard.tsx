/**
 * One of the server's pictures: the picture, its type, name and size, who uploaded it and
 * when, every place it is shown, and Delete.
 */

import { Badge, Box, Button, Card, Group, Stack, Text } from '@mantine/core';
import type { GuildUploadListing } from '@brattybot/web-sdk';
import { uploadImageUrl } from '../api/uploadImageUrl';
import { formatByteSize } from '../format/byteSize';
import { formatDay } from '../format/timestamps';
import { uploaderLabel, uploadTypeLabel } from './uploadPresentation';
import { UploadUses } from './UploadUses';

interface UploadCardProps {
    readonly guildId: string;
    readonly upload: GuildUploadListing;
    readonly viewerId: string | undefined;
    /** `opener` is the card's Delete button, for focus to come back to if the picture stays. */
    readonly onDelete: (upload: GuildUploadListing, opener: HTMLElement) => void;
}

export function UploadCard({ guildId, upload, viewerId, onDelete }: UploadCardProps) {
    return (
        <Card component="article" aria-label={upload.fileName} p={0} style={{ display: 'flex', flexDirection: 'column' }}>
            <Box pos="relative" h={150} bg="dark.7">
                <img
                    src={uploadImageUrl({ guildId, uploadId: upload.uploadId })}
                    alt=""
                    loading="lazy"
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
                <Badge
                    pos="absolute"
                    top={10}
                    left={10}
                    size="sm"
                    radius="xl"
                    variant="filled"
                    color="dark"
                    style={{ background: 'rgba(0,0,0,.55)', color: '#fff', letterSpacing: '.04em' }}
                >
                    {uploadTypeLabel(upload.contentType)}
                </Badge>
            </Box>
            <Stack gap={8} p="sm" pt={12} style={{ flex: 1 }}>
                <Text fw={700} size="14px" truncate title={upload.fileName}>
                    {upload.fileName}
                </Text>
                <Text size="12px" c="dark.3" truncate>
                    {formatByteSize(upload.byteSize)} · {uploaderLabel(upload.uploadedBy, viewerId)} ·{' '}
                    {formatDay(upload.createdAt)}
                </Text>
                {upload.uses.length > 0 ? (
                    <UploadUses uses={upload.uses} viewerId={viewerId} label={`Where ${upload.fileName} is used`} />
                ) : (
                    <Text size="12.5px" c="yellow.4">
                        ● Not used anywhere
                    </Text>
                )}
                <Group justify="flex-end" mt="auto" pt={4}>
                    <Button
                        size="compact-sm"
                        variant="light"
                        color="red"
                        aria-label={`Delete ${upload.fileName}`}
                        onClick={(event) => onDelete(upload, event.currentTarget)}
                    >
                        Delete
                    </Button>
                </Group>
            </Stack>
        </Card>
    );
}
