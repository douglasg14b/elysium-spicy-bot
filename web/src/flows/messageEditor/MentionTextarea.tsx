/**
 * A text box where Discord shows a mention as what it names: `@` opens a list of the server's
 * roles, `#` a list of its text channels and `:` a list of its emoji, and a pick is written as
 * `<@&id>`, `<#id>` or `<:name:id>` but shown, while typing, as `@Role name` in the role's colour,
 * `#channel-name` or `:name:` in the mention blurple — MEE6's mention box. The message window's parts draw it (`showsMentions`), and so
 * does the inspector's long text box for a field that declares it.
 *
 * Built on `react-mentions`, which keeps the two apart: the textarea holds the text as shown,
 * and every change hands back the text as stored, so each keystroke still goes to the node
 * with `<@&id>` and `<#id>` in it. A mention is one piece: Backspace removes it whole.
 *
 * The colours come from its highlighter, a copy of the text laid out exactly under the
 * textarea: the textarea's own text is made transparent, its caret left showing, and the
 * highlighter's text made visible — so a mention can be coloured, which a textarea cannot.
 */

import { useMemo, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { MentionsInput, type DataFunc, type MentionProps, type MentionsInputStyle } from 'react-mentions';
import { roleColorHex } from '../nodeMeta';
import { EmojiImage } from './EmojiImage';
import {
    CHANNEL_MENTION_MARKUP,
    CHANNEL_MENTION_PATTERN,
    CHANNEL_MENTION_STYLE,
    channelMentionLabel,
    EMOJI_MENTION_MARKUP,
    EMOJI_MENTION_PATTERN,
    emojiMentionId,
    parseEmojiReference,
    ROLE_MENTION_MARKUP,
    ROLE_MENTION_PATTERN,
    roleMentionLabel,
    roleMentionStyle,
    withKnownEmojis,
    type MentionableRole,
    type MentionLists,
} from './mentions';

interface MentionTextareaProps {
    readonly value: string;
    /** The text as stored — each mention as `<@&id>`, `<#id>` or `<:name:id>`. */
    readonly onChange: (next: string) => void;
    /** Only while a list is shut: while one is open, Enter, Tab, the arrows and Escape are its. */
    readonly onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
    /** The textarea's id, for a label outside it to name it by. */
    readonly id?: string;
    /** The textarea's accessible name, where no label names it. */
    readonly label?: string;
    /** The ids of what describes the textarea — a label's description and error, outside it. */
    readonly describedBy?: string;
    /** Whether what is typed is refused, said to assistive technology. */
    readonly invalid?: boolean;
    readonly placeholder?: string;
    /** Whether the box takes the focus as it appears — a part clicked open does; an inspector field does not. */
    readonly autoFocus?: boolean;
    /** The box's type and colour; its own layout is the highlighter's and the textarea's, alike. */
    readonly textStyle: CSSProperties;
    readonly mentions: MentionLists;
    /** Marks the lists, which are portalled out of the box, as the box's own. */
    readonly listAttribute?: string;
}

/** Above the message window (Mantine's modal sits at 200). */
const LIST_LAYER = 1000;

/** The textarea and its highlighter, laid out alike to the pixel — or the caret drifts off the text. */
const SHARED_LAYOUT: CSSProperties = {
    margin: 0,
    padding: 0,
    border: 0,
    font: 'inherit',
    lineHeight: 'inherit',
    letterSpacing: 'inherit',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
};

/**
 * The highlighter's plain text — its `substring` element, which the library hides so that only
 * the textarea's shows. The typings stop at the highlighter, so it is said by cast.
 */
const VISIBLE_SUBSTRING = { substring: { visibility: 'visible' } } as unknown as CSSProperties;

function boxStyle(textStyle: CSSProperties): MentionsInputStyle {
    return {
        control: { ...textStyle },
        highlighter: VISIBLE_SUBSTRING,
        '&multiLine': {
            highlighter: { ...SHARED_LAYOUT, color: textStyle.color },
            input: { ...SHARED_LAYOUT, color: 'transparent', caretColor: textStyle.color, outline: 'none' },
        },
        suggestions: {
            zIndex: LIST_LAYER,
            // The library backs the list in white, which shows at its rounded corners.
            backgroundColor: 'transparent',
            list: {
                background: 'var(--mantine-color-dark-7)',
                border: '1px solid var(--mantine-color-dark-4)',
                borderRadius: 8,
                padding: 4,
                minWidth: 240,
                // A channel name runs to 100 characters, and its category beside it: wrapped, not a list across the window.
                maxWidth: 420,
                maxHeight: 260,
                overflowY: 'auto',
                boxShadow: 'var(--mantine-shadow-md)',
            },
            item: {
                padding: '6px 10px',
                borderRadius: 6,
                fontSize: 14,
                fontWeight: 600,
                color: 'var(--mantine-color-gray-0)',
                '&focused': { background: 'var(--mantine-color-dark-5)' },
            },
        },
    };
}

interface MarkProps extends MentionProps {
    /** Set by the highlighter on each mention it draws. */
    readonly id?: string;
    readonly display?: string;
}

/**
 * The library's `Mention`, drawn in the role's own colour: the highlighter draws each mention by
 * cloning this element with its `id` and `display`, where the library's own draws every one
 * alike. Colour and background only — a change of weight or spacing would move the text off
 * the caret.
 */
function RoleMark({ id, display, roles }: MarkProps & { readonly roles: readonly MentionableRole[] }) {
    const { color, background } = roleMentionStyle(id ?? '', roles);
    return <strong style={{ fontWeight: 'inherit', color, background, borderRadius: 3 }}>{display}</strong>;
}

/** A channel's or an emoji's mark, in the mention blurple — colour and background only, as a role's. */
function BlurpleMark({ display }: MarkProps) {
    const { color, background } = CHANNEL_MENTION_STYLE;
    return <strong style={{ fontWeight: 'inherit', color, background, borderRadius: 3 }}>{display}</strong>;
}

/** A list's muted second line of a row: the category a channel sits in. */
const HINT_STYLE: CSSProperties = { color: 'var(--mantine-color-dark-2)', fontWeight: 400, marginLeft: 8 };

/** An emoji's row: its picture beside its `:name:`. */
const EMOJI_ROW_STYLE: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 8 };

/** Characters typed after `:` before emoji are offered — Discord's own rule, so a lone colon offers nothing. */
const EMOJI_QUERY_MINIMUM = 2;

/** Emoji offered at once, the way Discord's list is cut: a server may hold hundreds. */
const EMOJI_SUGGESTIONS_SHOWN = 25;

export function MentionTextarea({
    value,
    onChange,
    onKeyDown,
    id,
    label,
    describedBy,
    invalid,
    placeholder,
    autoFocus = false,
    textStyle,
    mentions,
    listAttribute,
}: MentionTextareaProps) {
    const { roles, channels, emojis } = mentions;
    const style = useMemo(() => boxStyle(textStyle), [textStyle]);
    // Asked per keystroke, so only once two characters are typed (Discord's own rule): a lone `:` offers nothing.
    const emojiData = useMemo<DataFunc>(
        () => (query) => {
            if (query.length < EMOJI_QUERY_MINIMUM) return [];
            const wanted = query.toLowerCase();
            return emojis
                .filter((emoji) => emoji.name.toLowerCase().includes(wanted))
                .slice(0, EMOJI_SUGGESTIONS_SHOWN)
                .map((emoji) => ({ id: emojiMentionId(emoji), display: emoji.name }));
        },
        [emojis]
    );
    // Highest first, as Discord lists them.
    const roleData = useMemo(
        () => [...roles].sort((left, right) => right.position - left.position).map((role) => ({ id: role.id, display: role.name })),
        [roles]
    );
    // In the order given — the channel picker's.
    const channelData = useMemo(() => channels.map((channel) => ({ id: channel.id, display: channel.name })), [channels]);
    // A click in a list keeps the focus in the text box, so the part stays open and typing carries on.
    const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();

    return (
        <MentionsInput
            id={id}
            aria-label={label}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            placeholder={placeholder}
            autoFocus={autoFocus}
            value={value}
            // A complete `:name:` of the server's is written as the emoji it names, as Discord's own app does.
            onChange={(_event, next) => onChange(withKnownEmojis(next, emojis))}
            onKeyDown={onKeyDown}
            allowSpaceInQuery
            style={style}
            suggestionsPortalHost={document.body}
            a11ySuggestionsListLabel="Roles, channels and emoji"
            customSuggestionsContainer={(list: ReactNode) => (
                <div className="nokey" onMouseDown={keepFocus} {...(listAttribute ? { [listAttribute]: true } : {})}>
                    {list}
                </div>
            )}
        >
            <RoleMark
                trigger="@"
                markup={ROLE_MENTION_MARKUP}
                regex={ROLE_MENTION_PATTERN}
                data={roleData}
                displayTransform={(roleId) => roleMentionLabel(roleId, roles)}
                renderSuggestion={(suggestion) => {
                    const color = roles.find((role) => role.id === suggestion.id)?.color;
                    return <span style={color ? { color: roleColorHex(color) } : undefined}>{suggestion.display}</span>;
                }}
                appendSpaceOnAdd
                // The library's `Mention` defaults this; read off this element, it must be said.
                isLoading={false}
                roles={roles}
            />
            <BlurpleMark
                trigger="#"
                markup={CHANNEL_MENTION_MARKUP}
                regex={CHANNEL_MENTION_PATTERN}
                data={channelData}
                displayTransform={(channelId) => channelMentionLabel(channelId, channels)}
                renderSuggestion={(suggestion) => {
                    const parentName = channels.find((channel) => channel.id === suggestion.id)?.parentName;
                    return (
                        <span>
                            #{suggestion.display}
                            {parentName ? <span style={HINT_STYLE}> {parentName}</span> : null}
                        </span>
                    );
                }}
                appendSpaceOnAdd
                isLoading={false}
            />
            <BlurpleMark
                trigger=":"
                markup={EMOJI_MENTION_MARKUP}
                regex={EMOJI_MENTION_PATTERN}
                data={emojiData}
                displayTransform={(emojiId) => `:${parseEmojiReference(emojiId).name}:`}
                renderSuggestion={(suggestion) => {
                    const { id, name, animated } = parseEmojiReference(String(suggestion.id));
                    return (
                        <span style={EMOJI_ROW_STYLE}>
                            <EmojiImage id={id} name={name} animated={animated} decorative />
                            :{name}:
                        </span>
                    );
                }}
                appendSpaceOnAdd
                isLoading={false}
            />
        </MentionsInput>
    );
}
