/**
 * One piece of text on the stage: shown as Discord will show it, and a text box in its place
 * once clicked — with its character count from `zDiscordMessage` and the `{x}` token picker.
 *
 * Every keystroke goes straight to the node (`apply`), as every inspector control's does, so
 * undo, the draft autosave and the server's re-check as focus leaves all keep working. A part
 * emptied is left out of the message (`setTextPart`).
 */

import { useEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from 'react';
import { ActionIcon, Box, Popover, Text, Textarea, UnstyledButton } from '@mantine/core';
import { withToken } from '../controls/TextControls';
import { VariablePicker } from '../controls/VariablePicker';
import { CopyText } from './CopyText';
import { DISCORD, PART_TYPE } from './discordLook';
import { useEditorScope } from './editorScope';
import { isRemovablePart, partLabel, partPath, readTextPart, setTextPart, type TextPart } from './messageDraft';
import { PartProblems } from './PartProblems';
import { partRule } from './partRules';

interface TextPartBoxProps {
    readonly part: TextPart;
    /** What an empty part says, in Edit. */
    readonly placeholder: string;
    /** Set over the part's own type (`PART_TYPE`) — a linked title is drawn as a link. */
    readonly styleOver?: CSSProperties;
    /** Whether Enter starts a new line, rather than finishing the part. */
    readonly multiline?: boolean;
    /** Whether the part takes `{{tokens}}`. A title link does not. */
    readonly takesTokens?: boolean;
}

/** Marks the token picker's box, which is portalled out of the part's own. */
const TOKEN_PICKER_ATTRIBUTE = 'data-part-token-picker';

/**
 * Kept clear of Mantine's form styling, so the box looks like the text it replaced. No height
 * of any kind — see `.mx-part-input` in `messageEditor.css`.
 */
const BARE_INPUT = { padding: 0, background: 'transparent', border: 'none' } as const;

export function TextPartBox({ part, placeholder, styleOver, multiline = false, takesTokens = true }: TextPartBoxProps) {
    const scope = useEditorScope();
    const text = readTextPart(scope.message, part) ?? '';
    const path = partPath(part);
    const label = partLabel(part);
    const textStyle: CSSProperties = { ...PART_TYPE[part.kind], ...styleOver };
    const knownVariables = scope.variables.map((variable) => variable.name);
    const display = useRef<HTMLButtonElement>(null);
    // Set as the part closes from the keyboard, so focus comes back to it rather than to the page.
    const returnFocus = useRef(false);
    const isEditing = scope.editing === path;

    useEffect(() => {
        if (!isEditing && returnFocus.current) {
            returnFocus.current = false;
            display.current?.focus();
        }
    }, [isEditing]);

    if (scope.mode === 'preview') {
        return text ? (
            <div style={{ ...textStyle, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                <CopyText text={text} preview knownVariables={knownVariables} />
            </div>
        ) : null;
    }

    const problems = scope.issues.byPart.get(path) ?? [];

    if (isEditing) {
        return (
            <PartInput
                part={part}
                text={text}
                label={label}
                problems={problems}
                textStyle={textStyle}
                multiline={multiline}
                takesTokens={takesTokens}
                onFinishFromKeyboard={() => {
                    returnFocus.current = true;
                }}
            />
        );
    }

    return (
        <div>
            <UnstyledButton
                ref={display}
                className="mx-part"
                aria-label={label}
                data-problem={problems.length > 0 || undefined}
                onClick={() => scope.setEditing(path)}
                style={{
                    ...textStyle,
                    display: 'block',
                    width: 'calc(100% + 10px)',
                    margin: '0 -5px',
                    padding: '2px 5px',
                    textAlign: 'left',
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                    cursor: 'text',
                }}
            >
                {text ? (
                    <CopyText text={text} preview={false} knownVariables={knownVariables} />
                ) : (
                    <span style={{ color: DISCORD.muted, fontWeight: 400 }}>{placeholder}</span>
                )}
            </UnstyledButton>
            <PartProblems problems={problems} />
        </div>
    );
}

interface PartInputProps {
    readonly part: TextPart;
    readonly text: string;
    readonly label: string;
    readonly problems: readonly string[];
    readonly textStyle: CSSProperties;
    readonly multiline: boolean;
    readonly takesTokens: boolean;
    /** Enter or Escape finished the part, so focus belongs back on it. */
    readonly onFinishFromKeyboard: () => void;
}

/** The part being typed into: a bare box over the text, its count above, `{x}` at its end. */
function PartInput({ part, text, label, problems, textStyle, multiline, takesTokens, onFinishFromKeyboard }: PartInputProps) {
    const scope = useEditorScope();
    const rule = partRule(part);
    // An emptied part is left out rather than empty, so only one that cannot be is judged empty.
    const judged = text !== '' || !isRemovablePart(part);
    // The schema's own sentence about the text as it is now, unless the server already said it.
    const live = judged ? rule.problem(text) : undefined;
    const serverOnly = problems.filter((problem) => problem !== live);
    const over = rule.maxLength !== null && text.length > rule.maxLength;

    const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Escape' || (event.key === 'Enter' && !multiline)) {
            // Escape is the window's too, which finishes the part being typed into.
            if (event.key === 'Enter') {
                event.preventDefault();
                scope.setEditing(null);
            }
            onFinishFromKeyboard();
        }
    };

    /*
     * The part closes when focus leaves it — but not for its own `{x}`, which Tab reaches, nor
     * for the picker that opens, which is portalled out of this box and so is asked by mark.
     */
    const left = (event: FocusEvent<HTMLDivElement>) => {
        const next = event.relatedTarget;
        if (next instanceof Element && (event.currentTarget.contains(next) || next.closest(`[${TOKEN_PICKER_ATTRIBUTE}]`))) {
            return;
        }
        scope.setEditing(null);
    };

    return (
        <div>
            <Box
                pos="relative"
                onBlur={left}
                style={{
                    border: '1px solid var(--mantine-color-brand-6)',
                    background: 'rgba(0,162,255,.06)',
                    borderRadius: 4,
                    margin: '0 -5px',
                    padding: takesTokens ? '2px 40px 2px 5px' : '2px 5px',
                }}
            >
                {rule.maxLength !== null ? (
                    <Text
                        component="span"
                        size="11px"
                        c={over ? 'red.4' : 'dark.2'}
                        style={{
                            position: 'absolute',
                            right: 6,
                            top: -20,
                            background: 'var(--mantine-color-dark-8)',
                            border: '1px solid var(--mantine-color-dark-5)',
                            borderRadius: 6,
                            padding: '1px 6px',
                            lineHeight: 1.4,
                        }}
                    >
                        {text.length} / {rule.maxLength}
                    </Text>
                ) : null}
                <Textarea
                    aria-label={label}
                    variant="unstyled"
                    autosize
                    minRows={1}
                    autoFocus
                    value={text}
                    onChange={(event) => {
                        const next = event.currentTarget.value;
                        scope.apply((message) => setTextPart(message, part, next));
                    }}
                    onKeyDown={keys}
                    classNames={{ input: 'mx-part-input' }}
                    styles={{ input: { ...BARE_INPUT, ...textStyle } }}
                />
                {takesTokens ? <TokenButton part={part} text={text} /> : null}
            </Box>
            {live ? <PartProblems problems={[live]} /> : null}
            <PartProblems problems={serverOnly} />
        </div>
    );
}

/**
 * `{x}`: the builder's token picker, under the part, appending as it does under every copy
 * field. A click on it or on a chip keeps the focus in the text box, so typing carries on
 * where it was; from the keyboard, Tab reaches it and the box stays open.
 */
function TokenButton({ part, text }: { readonly part: TextPart; readonly text: string }) {
    const scope = useEditorScope();
    const [opened, setOpened] = useState(false);
    const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();

    return (
        <Popover opened={opened} onChange={setOpened} position="bottom-end" width={380} withArrow shadow="md">
            <Popover.Target>
                <ActionIcon
                    variant="default"
                    size={22}
                    aria-label={`Insert a token into ${partLabel(part).toLowerCase()}`}
                    onMouseDown={keepFocus}
                    onClick={() => setOpened((open) => !open)}
                    style={{
                        position: 'absolute',
                        right: 4,
                        top: 4,
                        fontFamily: 'var(--mantine-font-family-monospace)',
                        fontSize: 11,
                        fontWeight: 700,
                        color: 'var(--mantine-color-brand-4)',
                    }}
                >
                    {'{x}'}
                </ActionIcon>
            </Popover.Target>
            <Popover.Dropdown className="nokey" onMouseDown={keepFocus} {...{ [TOKEN_PICKER_ATTRIBUTE]: true }}>
                <VariablePicker
                    variables={scope.variables}
                    requirements={scope.requirements}
                    value={text}
                    onInsert={(token) =>
                        scope.apply((message) => setTextPart(message, part, withToken(readTextPart(message, part) ?? '', token)))
                    }
                />
            </Popover.Dropdown>
        </Popover>
    );
}
