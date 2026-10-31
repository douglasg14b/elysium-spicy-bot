/**
 * The text box of a part where Discord shows a role mention (`showsRoleMentions`): `@` opens a
 * list of the server's roles, and a picked one is written as `<@&id>` but shown, while typing,
 * as `@Role name` in the role's colour — MEE6's mention box.
 *
 * Built on `react-mentions`, which keeps the two apart: the textarea holds the text as shown,
 * and every change hands back the text as stored, so each keystroke still goes to the node
 * with `<@&id>` in it. A mention is one piece: Backspace removes it whole.
 *
 * The colours come from its highlighter, a copy of the text laid out exactly under the
 * textarea: the textarea's own text is made transparent, its caret left showing, and the
 * highlighter's text made visible — so a mention can be coloured, which a textarea cannot.
 */

import { useMemo, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { MentionsInput, type MentionProps, type MentionsInputStyle } from 'react-mentions';
import { roleColorHex } from '../nodeMeta';
import {
    ROLE_MENTION_MARKUP,
    ROLE_MENTION_PATTERN,
    roleMentionLabel,
    roleMentionStyle,
    type MentionableRole,
} from './roleMentions';

interface RoleMentionTextareaProps {
    readonly value: string;
    /** The text as stored — each mention as `<@&id>`. */
    readonly onChange: (next: string) => void;
    /** Only while the role list is shut: while it is open, Enter, Tab, the arrows and Escape are its. */
    readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
    readonly label: string;
    readonly textStyle: CSSProperties;
    readonly roles: readonly MentionableRole[];
    /** Marks the role list, which is portalled out of the part's box, as the part's own. */
    readonly listAttribute: string;
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

interface RoleMarkProps extends MentionProps {
    readonly roles: readonly MentionableRole[];
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
function RoleMark({ id, display, roles }: RoleMarkProps) {
    const { color, background } = roleMentionStyle(id ?? '', roles);
    return <strong style={{ fontWeight: 'inherit', color, background, borderRadius: 3 }}>{display}</strong>;
}

export function RoleMentionTextarea({
    value,
    onChange,
    onKeyDown,
    label,
    textStyle,
    roles,
    listAttribute,
}: RoleMentionTextareaProps) {
    const style = useMemo(() => boxStyle(textStyle), [textStyle]);
    // Highest first, as Discord lists them.
    const data = useMemo(
        () => [...roles].sort((left, right) => right.position - left.position).map((role) => ({ id: role.id, display: role.name })),
        [roles]
    );
    // A click in the list keeps the focus in the text box, so the part stays open and typing carries on.
    const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();

    return (
        <MentionsInput
            aria-label={label}
            autoFocus
            value={value}
            onChange={(_event, next) => onChange(next)}
            onKeyDown={onKeyDown}
            allowSpaceInQuery
            style={style}
            suggestionsPortalHost={document.body}
            a11ySuggestionsListLabel="Roles"
            customSuggestionsContainer={(list: ReactNode) => (
                <div className="nokey" onMouseDown={keepFocus} {...{ [listAttribute]: true }}>
                    {list}
                </div>
            )}
        >
            <RoleMark
                trigger="@"
                markup={ROLE_MENTION_MARKUP}
                regex={ROLE_MENTION_PATTERN}
                data={data}
                displayTransform={(id) => roleMentionLabel(id, roles)}
                renderSuggestion={(suggestion) => {
                    const color = roles.find((role) => role.id === suggestion.id)?.color;
                    return <span style={color ? { color: roleColorHex(color) } : undefined}>{suggestion.display}</span>;
                }}
                appendSpaceOnAdd
                // The library's `Mention` defaults this; read off this element, it must be said.
                isLoading={false}
                roles={roles}
            />
        </MentionsInput>
    );
}
