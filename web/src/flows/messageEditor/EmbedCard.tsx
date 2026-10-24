/**
 * One embed on the stage, drawn as Discord draws it, with its tools beside it in Edit: colour
 * and move on the left, duplicate and delete on the right.
 */

import type { CSSProperties, ReactNode } from 'react';
import { ActionIcon, ColorPicker, Group, Popover, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import {
    IconArrowDown,
    IconArrowUp,
    IconChevronLeft,
    IconChevronRight,
    IconClock,
    IconCopy,
    IconLayoutColumns,
    IconPlus,
    IconTrash,
    IconX,
} from '@tabler/icons-react';
import { DISCORD, PART_TYPE, postedAtLabel, TOOL_COLUMN } from './discordLook';
import { useEditorScope } from './editorScope';
import {
    addField,
    deleteEmbed,
    duplicateEmbed,
    moveEmbed,
    moveField,
    removeField,
    setColour,
    setFieldInline,
    setTimestamp,
    type EmbedDraft,
} from './messageDraft';
import { MAX_EMBEDS, MAX_FIELDS } from './partRules';
import { PartProblems } from './PartProblems';
import { PictureSlot } from './PictureSlot';
import { TextPartBox } from './TextPartBox';

/**
 * Why the embed tools that renumber the embeds wait while a picture uploads: the upload lands
 * on the embed at the position it was sent from, which a move or delete would hand to another.
 */
const WAIT_FOR_UPLOAD = 'waits for the upload to finish';

export function EmbedCard({ index }: { readonly index: number }) {
    const scope = useEditorScope();
    const embed = scope.message.embeds[index];
    if (!embed) return null;

    const editing = scope.mode === 'edit';
    const problems = scope.issues.byEmbed.get(index) ?? [];
    const hasThumbnail = editing || !!embed.thumbnail;

    return (
        <Group align="flex-start" gap={10} wrap="nowrap" mb={12}>
            <Stack gap={6} w={TOOL_COLUMN} style={{ flex: 'none', paddingTop: 2 }}>
                {editing ? <LeftTools index={index} embed={embed} /> : null}
            </Stack>

            <div style={{ flex: '0 1 520px', minWidth: 0 }}>
                <div
                    data-problem={problems.length > 0 || undefined}
                    style={{
                        position: 'relative',
                        background: DISCORD.embed,
                        borderRadius: 4,
                        borderLeft: `4px solid ${embed.color ?? DISCORD.embedGrey}`,
                        outline: problems.length > 0 ? '1px dashed var(--mantine-color-red-5)' : undefined,
                        padding: '12px 16px 14px 12px',
                        color: DISCORD.text,
                    }}
                >
                    <div
                        style={{
                            display: 'grid',
                            gridTemplateColumns: hasThumbnail ? 'minmax(0, 1fr) 80px' : 'minmax(0, 1fr)',
                            gap: '0 16px',
                        }}
                    >
                        <Stack gap={6}>
                            <Group gap={8} wrap="nowrap" align="center">
                                <PictureSlot part={{ kind: 'authorIcon', embed: index }} />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <TextPartBox part={{ kind: 'authorName', embed: index }} placeholder="Header" />
                                </div>
                            </Group>
                            <Title index={index} embed={embed} />
                            <TextPartBox part={{ kind: 'description', embed: index }} placeholder="Write your message here!" multiline />
                        </Stack>
                        {hasThumbnail ? <PictureSlot part={{ kind: 'thumbnail', embed: index }} /> : null}
                    </div>

                    <Fields index={index} embed={embed} />

                    <div style={{ marginTop: 10 }}>
                        <PictureSlot part={{ kind: 'image', embed: index }} />
                    </div>

                    <Footer index={index} embed={embed} />
                </div>

                <PartProblems problems={problems} mt={4} />
            </div>

            <Stack gap={6} w={TOOL_COLUMN} style={{ flex: 'none', paddingTop: 2 }}>
                {editing ? <RightTools index={index} /> : null}
            </Stack>
        </Group>
    );
}

/** One square tool beside an embed. Never `disabled`: one that cannot act says so and does nothing. */
function Tool({
    label,
    onClick,
    inert = false,
    why,
    danger = false,
    children,
}: {
    readonly label: string;
    readonly onClick: () => void;
    readonly inert?: boolean;
    /** Said beside the label while the tool is inert for a passing reason. */
    readonly why?: string;
    readonly danger?: boolean;
    readonly children: ReactNode;
}) {
    return (
        <Tooltip label={inert && why ? `${label} — ${why}` : label} withArrow position="left">
            <ActionIcon
                variant={danger ? 'light' : 'default'}
                color={danger ? 'red' : undefined}
                size={TOOL_COLUMN}
                radius="md"
                aria-label={label}
                aria-disabled={inert || undefined}
                onClick={inert ? undefined : onClick}
                style={inert ? { opacity: 0.4, cursor: 'default' } : undefined}
            >
                {children}
            </ActionIcon>
        </Tooltip>
    );
}

function LeftTools({ index, embed }: { readonly index: number; readonly embed: EmbedDraft }) {
    const scope = useEditorScope();
    const count = scope.message.embeds.length;
    const name = `embed ${index + 1}`;

    return (
        <>
            <Popover position="right-start" withArrow shadow="md">
                <Popover.Target>
                    <Tooltip label="Colour" withArrow position="left">
                        <ActionIcon variant="default" size={TOOL_COLUMN} radius="md" aria-label={`Colour of ${name}`}>
                            <span
                                style={{
                                    width: 16,
                                    height: 16,
                                    borderRadius: '50%',
                                    background: embed.color ?? DISCORD.embedGrey,
                                    boxShadow: '0 0 0 2px rgba(255,255,255,.15)',
                                }}
                            />
                        </ActionIcon>
                    </Tooltip>
                </Popover.Target>
                <Popover.Dropdown className="nokey">
                    {/*
                     * Written when a drag ends or a swatch is picked, not on every step of a
                     * drag, which would fill the undo history with one colour per pixel. Keyed
                     * by the colour, so one set from outside (No colour, undo) is shown.
                     */}
                    <ColorPicker
                        key={embed.color ?? 'none'}
                        format="hex"
                        defaultValue={embed.color ?? ''}
                        onChangeEnd={(colour) => scope.apply((message) => setColour(message, index, colour))}
                        swatches={[...scope.swatches]}
                        swatchesPerRow={scope.swatches.length || undefined}
                    />
                    <UnstyledButton
                        mt={8}
                        onClick={() => scope.apply((message) => setColour(message, index, undefined))}
                        style={{ fontSize: 12, color: 'var(--mantine-color-dark-2)' }}
                    >
                        No colour (Discord grey)
                    </UnstyledButton>
                </Popover.Dropdown>
            </Popover>
            <Tool
                label={`Move ${name} up`}
                inert={index === 0 || scope.uploading}
                why={scope.uploading ? WAIT_FOR_UPLOAD : undefined}
                onClick={() => scope.apply((message) => moveEmbed(message, index, -1))}
            >
                <IconArrowUp size={15} />
            </Tool>
            <Tool
                label={`Move ${name} down`}
                inert={index === count - 1 || scope.uploading}
                why={scope.uploading ? WAIT_FOR_UPLOAD : undefined}
                onClick={() => scope.apply((message) => moveEmbed(message, index, 1))}
            >
                <IconArrowDown size={15} />
            </Tool>
        </>
    );
}

function RightTools({ index }: { readonly index: number }) {
    const scope = useEditorScope();
    const name = `embed ${index + 1}`;
    const full = scope.message.embeds.length >= MAX_EMBEDS;

    return (
        <>
            <Tool
                label={`Duplicate ${name}`}
                inert={full || scope.uploading}
                why={scope.uploading ? WAIT_FOR_UPLOAD : undefined}
                onClick={() => scope.apply((message) => duplicateEmbed(message, index))}
            >
                <IconCopy size={15} />
            </Tool>
            <Tool
                label={`Delete ${name}`}
                danger
                inert={scope.uploading}
                why={scope.uploading ? WAIT_FOR_UPLOAD : undefined}
                onClick={() => scope.apply((message) => deleteEmbed(message, index))}
            >
                <IconTrash size={15} />
            </Tool>
        </>
    );
}

/** The title, and — in Edit — its link under it; in Preview a linked title is drawn as a link. */
function Title({ index, embed }: { readonly index: number; readonly embed: EmbedDraft }) {
    const scope = useEditorScope();
    const linked: CSSProperties = embed.url && scope.mode === 'preview' ? { color: DISCORD.link } : {};

    return (
        <div>
            <TextPartBox part={{ kind: 'title', embed: index }} placeholder="Title" styleOver={linked} />
            {scope.mode === 'edit' ? (
                <TextPartBox part={{ kind: 'url', embed: index }} placeholder="+ Link the title" takesTokens={false} />
            ) : null}
        </div>
    );
}

function Fields({ index, embed }: { readonly index: number; readonly embed: EmbedDraft }) {
    const scope = useEditorScope();
    const fields = embed.fields ?? [];
    const editing = scope.mode === 'edit';
    if (fields.length === 0 && !editing) return null;

    return (
        <div style={{ marginTop: 10 }}>
            {fields.length > 0 ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '8px 12px' }}>
                    {fields.map((field, fieldIndex) => (
                        <div
                            key={fieldIndex}
                            className="mx-field"
                            style={{ gridColumn: field.inline ? undefined : '1 / -1', position: 'relative', minWidth: 0 }}
                        >
                            {editing ? <FieldTools index={index} fieldIndex={fieldIndex} inline={!!field.inline} count={fields.length} /> : null}
                            <TextPartBox part={{ kind: 'fieldName', embed: index, field: fieldIndex }} placeholder="Field heading" />
                            <TextPartBox part={{ kind: 'fieldValue', embed: index, field: fieldIndex }} placeholder="Field text" multiline />
                        </div>
                    ))}
                </div>
            ) : null}
            {editing && fields.length < MAX_FIELDS ? (
                <UnstyledButton
                    mt={fields.length > 0 ? 8 : 0}
                    onClick={() => scope.apply((message) => addField(message, index))}
                    style={{ color: DISCORD.link, fontSize: 13.5, fontWeight: 600 }}
                >
                    <Group gap={4} wrap="nowrap">
                        <IconPlus size={14} />
                        Add new field
                    </Group>
                </UnstyledButton>
            ) : null}
        </div>
    );
}

/** A field's own tools, shown while the pointer or focus is on it. */
function FieldTools({
    index,
    fieldIndex,
    inline,
    count,
}: {
    readonly index: number;
    readonly fieldIndex: number;
    readonly inline: boolean;
    readonly count: number;
}) {
    const scope = useEditorScope();
    const name = `embed ${index + 1} field ${fieldIndex + 1}`;
    const tool = { variant: 'subtle', color: 'gray', size: 20 } as const;

    return (
        <Group gap={2} className="mx-field-tools" style={{ position: 'absolute', top: -2, right: 0, zIndex: 1 }} wrap="nowrap">
            <ActionIcon
                {...tool}
                aria-label={inline ? `Put ${name} on a row of its own` : `Sit ${name} beside its neighbours`}
                aria-pressed={inline}
                onClick={() => scope.apply((message) => setFieldInline(message, index, fieldIndex, !inline))}
                c={inline ? 'brand.4' : undefined}
            >
                <IconLayoutColumns size={13} />
            </ActionIcon>
            {fieldIndex > 0 ? (
                <ActionIcon
                    {...tool}
                    aria-label={`Move ${name} back`}
                    onClick={() => scope.apply((message) => moveField(message, index, fieldIndex, -1))}
                >
                    <IconChevronLeft size={13} />
                </ActionIcon>
            ) : null}
            {fieldIndex < count - 1 ? (
                <ActionIcon
                    {...tool}
                    aria-label={`Move ${name} on`}
                    onClick={() => scope.apply((message) => moveField(message, index, fieldIndex, 1))}
                >
                    <IconChevronRight size={13} />
                </ActionIcon>
            ) : null}
            <ActionIcon
                {...tool}
                aria-label={`Remove ${name}`}
                onClick={() => scope.apply((message) => removeField(message, index, fieldIndex))}
            >
                <IconX size={13} />
            </ActionIcon>
        </Group>
    );
}

function Footer({ index, embed }: { readonly index: number; readonly embed: EmbedDraft }) {
    const scope = useEditorScope();
    const editing = scope.mode === 'edit';
    const shown = embed.timestamp === true;
    if (!editing && !embed.footer && !shown) return null;

    return (
        <Group gap={8} mt={10} wrap="nowrap" align="center">
            <PictureSlot part={{ kind: 'footerIcon', embed: index }} />
            <div style={{ flex: editing ? 1 : '0 1 auto', minWidth: 0 }}>
                <TextPartBox part={{ kind: 'footerText', embed: index }} placeholder="Footer" multiline />
            </div>
            {editing ? (
                <UnstyledButton
                    aria-pressed={shown}
                    aria-label={shown ? `Timestamp on for embed ${index + 1}` : `Timestamp off for embed ${index + 1}`}
                    onClick={() => scope.apply((message) => setTimestamp(message, index, !shown))}
                    style={{
                        marginLeft: 'auto',
                        flex: 'none',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 11.5,
                        borderRadius: 20,
                        padding: '2px 9px',
                        border: shown ? '1px solid rgba(0,162,255,.5)' : `1px dashed ${DISCORD.outline}`,
                        color: shown ? 'var(--mantine-color-brand-4)' : DISCORD.muted,
                    }}
                >
                    <IconClock size={12} />
                    {shown ? 'Timestamp on' : 'Timestamp off'}
                </UnstyledButton>
            ) : shown ? (
                <Text component="span" style={{ ...PART_TYPE.footerText }}>
                    {embed.footer?.text ? '• ' : ''}
                    {postedAtLabel(new Date())}
                </Text>
            ) : null}
        </Group>
    );
}
