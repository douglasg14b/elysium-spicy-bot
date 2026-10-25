/**
 * One picture on the stage — header icon, thumbnail, image or footer icon — and, in Edit, the
 * box it opens: an upload, a link, or a token, plus the pictures this server already holds.
 *
 * An upload is sent the moment it is dropped or picked, and the part is set to it when the
 * server answers. Nothing is ever `disabled` while it travels: a focused input that is
 * disabled loses its focus, and the author may well be typing elsewhere in the window. The
 * upload says it is on its way in words instead.
 */

import { useRef, useState, type CSSProperties, type DragEvent } from 'react';
import {
    Anchor,
    Box,
    Button,
    FileButton,
    Group,
    Loader,
    Popover,
    SegmentedControl,
    Stack,
    Text,
    TextInput,
    UnstyledButton,
} from '@mantine/core';
import { IconPhoto, IconPlus, IconUpload, IconUser } from '@tabler/icons-react';
import { VariablePicker } from '../controls/VariablePicker';
import { withToken } from '../controls/TextControls';
import { uploadRefusalSentence } from '../../uploads/keepGuildUpload';
import { UPLOAD_SIZE_LABEL } from '../../uploads/uploadLimits';
import { ACCEPTED_UPLOAD_TYPES, UPLOAD_TYPES_HINT } from '../../uploads/uploadTypes';
import { DISCORD } from './discordLook';
import { useEditorScope } from './editorScope';
import { partLabel, partNoun, partPath, readPicture, setPicture, type PictureKind, type PicturePart } from './messageDraft';
import { PartProblems } from './PartProblems';
import { readPictureValue, uploadRef, type PictureValue } from './pictureValue';


/** How many of the server's uploads show before "+N". */
const RECENT_SHOWN = 7;

/** How each picture sits on the stage: a small round icon, the thumbnail square, or the wide image. */
const SHAPES: Readonly<Record<PictureKind, CSSProperties>> = {
    authorIcon: { width: 24, height: 24, borderRadius: '50%' },
    footerIcon: { width: 20, height: 20, borderRadius: '50%' },
    thumbnail: { width: 80, height: 80, borderRadius: 6 },
    image: { width: '100%', height: 150, borderRadius: 6 },
};

type PictureTab = 'upload' | 'link' | 'token';

/**
 * The tab a picture opens on: its own kind's. A token in a message that takes none opens on
 * Link, where its text can be seen and replaced — the part already says it cannot stay.
 */
function tabFor(value: PictureValue | undefined, tokens: boolean): PictureTab {
    if (value?.kind === 'token') return tokens ? 'token' : 'link';
    return value?.kind === 'link' ? 'link' : 'upload';
}

const UPLOAD_TAB = { value: 'upload', label: 'Upload' } as const;
const LINK_TAB = { value: 'link', label: 'Link' } as const;
const TOKEN_TAB = { value: 'token', label: 'Token' } as const;

export function PictureSlot({ part }: { readonly part: PicturePart }) {
    const scope = useEditorScope();
    const [opened, setOpened] = useState(false);
    const target = useRef<HTMLButtonElement>(null);
    const value = readPicture(scope.message, part);
    const picture = value ? readPictureValue(value) : undefined;
    const problems = scope.issues.byPart.get(partPath(part)) ?? [];

    if (scope.mode === 'preview') {
        return picture ? <PictureFace part={part} picture={picture} /> : null;
    }

    /*
     * Closed from inside — Escape, Done, Remove — focus goes back to the picture, so a second
     * Escape reaches the window. Not on a click elsewhere, which has put focus where it wanted.
     */
    const close = () => {
        setOpened(false);
        target.current?.focus();
    };

    return (
        <Popover opened={opened} onChange={setOpened} width={330} position="bottom" withArrow shadow="xl" closeOnEscape={false}>
            <Popover.Target>
                <UnstyledButton
                    ref={target}
                    className="mx-picture"
                    aria-label={partLabel(part)}
                    data-problem={problems.length > 0 || undefined}
                    onClick={() => setOpened((open) => !open)}
                    style={{
                        flex: 'none',
                        display: 'block',
                        outline: problems.length > 0 ? '1px dashed var(--mantine-color-red-5)' : undefined,
                        outlineOffset: 2,
                        ...(part.kind === 'image' ? { width: '100%' } : {}),
                    }}
                >
                    {picture ? <PictureFace part={part} picture={picture} /> : <EmptyPicture kind={part.kind} />}
                </UnstyledButton>
            </Popover.Target>
            <Popover.Dropdown className="nokey" p={12} onKeyDown={(event) => event.key === 'Escape' && close()}>
                <PictureChooser part={part} problems={problems} onDone={close} />
            </Popover.Dropdown>
        </Popover>
    );
}

/** A picture part with nothing in it: a dashed outline in its shape. */
function EmptyPicture({ kind }: { readonly kind: PictureKind }) {
    const round = kind === 'authorIcon' || kind === 'footerIcon';
    return (
        <Box
            style={{
                ...SHAPES[kind],
                border: `1px dashed ${DISCORD.placeholderEdge}`,
                color: DISCORD.muted,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                fontSize: 13,
            }}
        >
            {round ? <IconPlus size={kind === 'authorIcon' ? 12 : 11} /> : <IconPhoto size={kind === 'image' ? 18 : 22} stroke={1.5} />}
            {kind === 'image' ? 'Add an image' : null}
        </Box>
    );
}

/**
 * A picture as it will look: the upload or the link itself, or — for a token, which only a
 * run can fill in — a stand-in face, since `{{subject.avatarUrl}}` is the token a picture
 * almost always holds.
 */
function PictureFace({ part, picture }: { readonly part: PicturePart; readonly picture: PictureValue }) {
    const { uploads } = useEditorScope();
    const shape = SHAPES[part.kind];

    if (picture.kind === 'token') {
        return (
            <Box
                aria-label="A stand-in face, filled in when the flow runs"
                role="img"
                style={{
                    ...shape,
                    background: 'radial-gradient(circle at 35% 30%, #5ebaff, #3a3f8f)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'rgba(255,255,255,.85)',
                }}
            >
                <IconUser size={part.kind === 'image' ? 48 : part.kind === 'thumbnail' ? 36 : 13} stroke={1.6} />
            </Box>
        );
    }

    const source = picture.kind === 'upload' ? uploads.imageUrl(picture.uploadId) : picture.url;
    const sized: CSSProperties =
        part.kind === 'image'
            ? { display: 'block', maxWidth: '100%', maxHeight: 300, borderRadius: 6 }
            : { ...shape, display: 'block', objectFit: 'cover' };
    return <img src={source} alt="" referrerPolicy="no-referrer" style={sized} />;
}

interface PictureChooserProps {
    readonly part: PicturePart;
    readonly problems: readonly string[];
    readonly onDone: () => void;
}

/** The box a picture opens: Upload | Link | Token, the server's pictures, and Remove. */
function PictureChooser({ part, problems, onDone }: PictureChooserProps) {
    const scope = useEditorScope();
    const value = readPicture(scope.message, part) ?? '';
    const picture = value ? readPictureValue(value) : undefined;
    const [tab, setTab] = useState<PictureTab>(tabFor(picture, scope.tokens));
    // Only text a person typed is offered back to edit: an upload ref is not something to type over.
    const typed = picture?.kind === 'upload' ? '' : value;
    const noun = partNoun(part.kind);
    const set = (ref: string | undefined) => scope.apply((message) => setPicture(message, part, ref));

    return (
        <Stack gap={10}>
            <SegmentedControl
                fullWidth
                size="xs"
                value={tab}
                onChange={(next) => setTab(next as PictureTab)}
                data={scope.tokens ? [UPLOAD_TAB, LINK_TAB, TOKEN_TAB] : [UPLOAD_TAB, LINK_TAB]}
            />

            {tab === 'upload' ? <UploadTab current={picture} onPick={(uploadId) => set(uploadRef(uploadId))} /> : null}

            {tab === 'link' ? (
                <TextInput
                    label="Picture link"
                    description="A full http:// or https:// link to a picture."
                    placeholder="https://…"
                    value={typed}
                    onChange={(event) => set(event.currentTarget.value)}
                />
            ) : null}

            {tab === 'token' ? (
                <div>
                    <TextInput
                        label="Token"
                        description="Filled in when the flow runs — it has to come out as a link."
                        placeholder="{{subject.avatarUrl}}"
                        value={typed}
                        onChange={(event) => set(event.currentTarget.value)}
                    />
                    <VariablePicker
                        variables={scope.variables}
                        requirements={scope.requirements}
                        value={typed}
                        onInsert={(token) => set(withToken(typed, token))}
                    />
                </div>
            ) : null}

            <PartProblems problems={problems} mt={0} />

            <Group justify="flex-end" gap={8}>
                {value ? (
                    <Button
                        variant="subtle"
                        color="gray"
                        size="xs"
                        onClick={() => {
                            set(undefined);
                            onDone();
                        }}
                    >
                        Remove {noun}
                    </Button>
                ) : null}
                <Button size="xs" onClick={onDone}>
                    Done
                </Button>
            </Group>
        </Stack>
    );
}

interface UploadTabProps {
    readonly current: PictureValue | undefined;
    readonly onPick: (uploadId: string) => void;
}

/** Drop or browse to upload, and the server's pictures to pick from. */
function UploadTab({ current, onPick }: UploadTabProps) {
    const { uploads, trackUpload } = useEditorScope();
    const [sending, setSending] = useState<string | null>(null);
    const [refusal, setRefusal] = useState<string | null>(null);
    const [showAll, setShowAll] = useState(false);
    const resetChooser = useRef<() => void>(null);
    // Read at the moment of a second drop, which a render may not have caught up with yet.
    const busy = useRef(false);

    const send = async (file: File | null | undefined) => {
        // One at a time, by ignoring a second rather than disabling anything (see the file header).
        if (!file || busy.current) return;
        busy.current = true;
        setSending(file.name);
        setRefusal(null);
        try {
            const kept = await trackUpload(uploads.upload(file));
            onPick(kept.uploadId);
        } catch (error) {
            setRefusal(uploadRefusalSentence(error));
        } finally {
            busy.current = false;
            setSending(null);
            resetChooser.current?.();
        }
    };

    const dropped = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        void send(event.dataTransfer.files[0]);
    };

    const shown = showAll ? uploads.items : uploads.items.slice(0, RECENT_SHOWN);
    const hidden = uploads.items.length - shown.length;
    const currentId = current?.kind === 'upload' ? current.uploadId : undefined;

    return (
        <div>
            <Box
                onDragOver={(event) => event.preventDefault()}
                onDrop={dropped}
                style={{
                    border: '1.5px dashed var(--mantine-color-dark-4)',
                    borderRadius: 'var(--mantine-radius-sm)',
                    padding: 14,
                    textAlign: 'center',
                    background: 'rgba(0,162,255,.03)',
                }}
            >
                <IconUpload size={20} color="var(--mantine-color-brand-4)" style={{ marginBottom: 4 }} />
                <Text size="12.5px" c="dark.1">
                    <b>Drop an image here</b> or{' '}
                    <FileButton
                        onChange={(file) => void send(file)}
                        accept={ACCEPTED_UPLOAD_TYPES}
                        resetRef={resetChooser}
                        inputProps={{ 'aria-label': 'Upload a picture' }}
                    >
                        {(props) => (
                            <Anchor component="button" type="button" size="12.5px" fw={700} {...props}>
                                browse
                            </Anchor>
                        )}
                    </FileButton>
                </Text>
                {sending ? (
                    <Group gap={6} justify="center" mt={4} role="status">
                        <Loader size={12} />
                        <Text size="11.5px" c="dark.2">
                            Uploading {sending}…
                        </Text>
                    </Group>
                ) : (
                    <Text size="11.5px" c="dark.3" mt={2}>
                        {UPLOAD_TYPES_HINT} · up to {UPLOAD_SIZE_LABEL}
                    </Text>
                )}
            </Box>

            {refusal ? (
                <Text size="11.5px" c="yellow.5" mt={6} role="alert">
                    {refusal}
                </Text>
            ) : null}

            <Text size="11.5px" c="dark.2" fw={600} mt={10} mb={6}>
                Already uploaded to this server
            </Text>
            {uploads.items.length === 0 ? (
                <Text size="11.5px" c="dark.3">
                    Nothing yet — whatever you upload first lands here.
                </Text>
            ) : (
                <Group gap={6}>
                    {shown.map((upload) => (
                        <UnstyledButton
                            key={upload.uploadId}
                            aria-label={`Use ${upload.fileName}`}
                            aria-pressed={upload.uploadId === currentId}
                            onClick={() => onPick(upload.uploadId)}
                            style={{
                                borderRadius: 6,
                                outline: upload.uploadId === currentId ? '2px solid var(--mantine-color-brand-6)' : undefined,
                                outlineOffset: 1,
                            }}
                        >
                            <img
                                src={uploads.imageUrl(upload.uploadId)}
                                alt=""
                                style={{ width: 46, height: 46, borderRadius: 6, objectFit: 'cover', display: 'block' }}
                            />
                        </UnstyledButton>
                    ))}
                    {hidden > 0 ? (
                        <UnstyledButton
                            aria-label={`Show ${hidden} more`}
                            onClick={() => setShowAll(true)}
                            style={{
                                width: 46,
                                height: 46,
                                borderRadius: 6,
                                background: 'var(--mantine-color-dark-6)',
                                color: 'var(--mantine-color-dark-2)',
                                fontSize: 12,
                                fontWeight: 700,
                                textAlign: 'center',
                            }}
                        >
                            +{hidden}
                        </UnstyledButton>
                    ) : null}
                </Group>
            )}
        </div>
    );
}
