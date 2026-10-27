/**
 * A button's emoji, label and style, as the message window's button box and the Button Click
 * trigger's "+ New button" both ask for them — one set of fields, so a button reads the same
 * wherever it is made.
 */

import { lazy, Suspense, useRef, useState } from 'react';
import { CloseButton, Group, Loader, Popover, SegmentedControl, Text, TextInput, UnstyledButton } from '@mantine/core';
import { IconMoodSmile } from '@tabler/icons-react';
import type { GuildEmoji, MessageButtonEmoji, MessageButtonStyle } from '@brattybot/web-sdk';
import { emojiText, isEmojiGone } from '../buttonEmoji';
import { EmojiGlyph } from './ButtonFace';
import { BUTTON_STYLE_ORDER, BUTTON_STYLES, DISCORD } from './discordLook';
import { BUTTON_LABEL_RULE } from './partRules';

/** The grid, loaded the first time one opens: the package and its emoji data stay out of the page until then. */
const EmojiGrid = lazy(() => import('./EmojiGrid').then((module) => ({ default: module.EmojiGrid })));

interface ButtonEmojiFieldProps {
    readonly value: MessageButtonEmoji | undefined;
    /** The emoji picked, or `undefined` to take it off. */
    readonly onChange: (next: MessageButtonEmoji | undefined) => void;
    /** The server's own emoji: `undefined` until read, or after the read failed. */
    readonly serverEmojis: readonly GuildEmoji[] | undefined;
}

/**
 * The emoji beside the label: a square showing it — or a smiley, when there is none — which
 * opens the grid, and ✕ beside it to take it off. Under it, when the server no longer has the
 * emoji picked, a note that the button will post without it; not a problem with the message,
 * so it never holds a save.
 *
 * The grid is a popover inside the box's own popover, so it sits in the box's DOM rather than
 * in a portal: a click in it is then a click inside the box, which stays open. Escape is
 * handled on the way up rather than by Mantine's capturing handler, which would shut the box
 * before the grid; the grid's Escape stops there, and the box's own (`ButtonRow`, `"+ New
 * button"`) is left for the next one, as a picture's box does (`PictureSlot`).
 */
export function ButtonEmojiField({ value, onChange, serverEmojis }: ButtonEmojiFieldProps) {
    const [picking, setPicking] = useState(false);
    const square = useRef<HTMLButtonElement>(null);
    const gone = value ? isEmojiGone(value, serverEmojis) : false;

    // Picked, cleared or escaped: focus goes back to the square, rather than to the page.
    const done = () => {
        setPicking(false);
        square.current?.focus();
    };

    return (
        <div>
            <Text size="sm" fw={500} mb={4}>
                Emoji
            </Text>
            <Group gap={6} wrap="nowrap">
                <Popover
                    opened={picking}
                    onChange={setPicking}
                    position="bottom-start"
                    shadow="xl"
                    withinPortal={false}
                    closeOnEscape={false}
                >
                    <Popover.Target>
                        <UnstyledButton
                            ref={square}
                            aria-label={value ? `Emoji ${emojiText(value)} — pick another` : 'Pick an emoji'}
                            aria-haspopup="dialog"
                            onClick={() => setPicking((open) => !open)}
                            style={{
                                width: 36,
                                height: 36,
                                flex: 'none',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                borderRadius: 'var(--mantine-radius-sm)',
                                border: '1px solid var(--mantine-color-dark-4)',
                                background: 'var(--mantine-color-dark-6)',
                            }}
                        >
                            {value ? <EmojiGlyph emoji={value} size={22} /> : <IconMoodSmile size={20} color={DISCORD.muted} stroke={1.5} />}
                        </UnstyledButton>
                    </Popover.Target>
                    <Popover.Dropdown
                        p={0}
                        onKeyDown={(event) => {
                            if (event.key !== 'Escape') return;
                            event.stopPropagation();
                            done();
                        }}
                    >
                        <Suspense fallback={<Loader size="sm" m={14} />}>
                            <EmojiGrid
                                serverEmojis={serverEmojis}
                                onPick={(picked) => {
                                    onChange(picked);
                                    done();
                                }}
                            />
                        </Suspense>
                    </Popover.Dropdown>
                </Popover>
                {value ? (
                    <CloseButton
                        size="sm"
                        aria-label="Take the emoji off"
                        onClick={() => {
                            onChange(undefined);
                            square.current?.focus();
                        }}
                    />
                ) : (
                    <Text size="11.5px" c="dark.2">
                        Optional — with a label, or on its own.
                    </Text>
                )}
            </Group>
            {gone ? (
                <Text size="11.5px" c="yellow.5" mt={4}>
                    This emoji&apos;s gone from the server — it&apos;ll post without it.
                </Text>
            ) : null}
        </div>
    );
}

interface ButtonLabelFieldProps {
    readonly value: string;
    readonly onChange: (next: string) => void;
    readonly autoFocus?: boolean;
}

/** The label, with how much of its 80 characters it spends. */
export function ButtonLabelField({ value, onChange, autoFocus }: ButtonLabelFieldProps) {
    const maxLength = BUTTON_LABEL_RULE.maxLength ?? Number.POSITIVE_INFINITY;
    const over = value.length > maxLength;

    return (
        <TextInput
            label="Label"
            value={value}
            data-autofocus={autoFocus || undefined}
            onChange={(event) => onChange(event.currentTarget.value)}
            rightSectionWidth={64}
            rightSection={
                <Text size="11px" c={over ? 'red.4' : 'dark.2'}>
                    {value.length} / {BUTTON_LABEL_RULE.maxLength}
                </Text>
            }
        />
    );
}

interface ButtonStyleFieldProps {
    readonly value: MessageButtonStyle;
    readonly onChange: (next: MessageButtonStyle) => void;
}

/** The style, each named as the dashboard calls it beside a swatch of Discord's colour. */
export function ButtonStyleField({ value, onChange }: ButtonStyleFieldProps) {
    return (
        <div>
            <Text size="sm" fw={500} mb={4}>
                Style
            </Text>
            <SegmentedControl
                fullWidth
                size="xs"
                aria-label="Style"
                value={value}
                onChange={(next) => onChange(next as MessageButtonStyle)}
                data={BUTTON_STYLE_ORDER.map((style) => ({
                    value: style,
                    label: (
                        <Group gap={5} wrap="nowrap" justify="center">
                            <span
                                aria-hidden
                                style={{ width: 9, height: 9, borderRadius: 2, background: BUTTON_STYLES[style].colour, flex: 'none' }}
                            />
                            {BUTTON_STYLES[style].name}
                        </Group>
                    ),
                }))}
            />
        </div>
    );
}
