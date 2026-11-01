/**
 * Free-text controls. `text` is one line; `longText` autosizes for a message body, and offers
 * `@role` and `#channel` where its text lands somewhere Discord shows a mention by name.
 */

import { useId, useMemo, type CSSProperties } from 'react';
import { Input, Textarea, TextInput } from '@mantine/core';
import { asText, type ControlContext, type ControlProps } from './types';
import type { BlockConfigField } from '@brattybot/web-sdk';
import { MentionTextarea } from '../messageEditor/MentionTextarea';
import { mentionListsOf, type MentionLists } from '../messageEditor/mentions';
import { CopyPreview } from './CopyPreview';
import { VariablePicker } from './VariablePicker';

type TextField = Extract<BlockConfigField, { control: 'text' }>;
type LongTextField = Extract<BlockConfigField, { control: 'longText' }>;

/**
 * The browser's hard character cap, which a copy field must not have.
 *
 * `maxLength` on the input stops the author typing past the limit — correct for a
 * plain string, wrong for copy, because the engine measures the string *after*
 * `{{subject.mention}}` and friends expand. A 1990-character template with three
 * mentions in it is under the cap here and over it at runtime, and nothing on the
 * save path can tell. Letting the author type it and failing nameably at render
 * beats a cap that quietly measures the wrong string.
 */
function hardLimit(field: TextField | LongTextField): number | undefined {
    return field.rendersTokens ? undefined : field.maxLength;
}

/** The limit as advice, for a field where it cannot be enforced as you type. */
function limitHint(field: TextField | LongTextField): string | undefined {
    if (!field.rendersTokens || field.maxLength === undefined) {
        return field.description;
    }

    const limit = `Up to ${field.maxLength} characters once any {{tokens}} are filled in.`;
    return field.description ? `${field.description} ${limit}` : limit;
}

/**
 * The token affordances under a copy field, or nothing.
 *
 * Gated on `rendersTokens` — the same declaration the engine expands by and that
 * save-time validation finds copy fields with. A field that is not copy (a
 * variable *name*, a message id, an emoji) has no tokens expanded in it, so
 * offering to insert one there would be offering to break it.
 *
 * Reading order is what the author needs in the order they need it: what this
 * becomes, then what else they could add, then what is wrong with it.
 *
 * Appends rather than inserting at the caret. A caret-aware insert needs a ref
 * and a controlled selection, and this is a token an author almost always adds at
 * the end of what they are writing; appending is the version worth shipping until
 * somebody wants the other.
 */
function variableHints(
    field: TextField | LongTextField,
    value: unknown,
    context: ControlContext,
    onAppend: (token: string) => void,
    /** For a box that draws mentions by name: the preview draws them by name too. */
    mentions?: MentionLists
) {
    // A message body is a `longText`; a single line is a title, a reason or a value to
    // compare, where `<#id>` would show raw or be compared as written.
    const channelLinks = field.control === 'longText';
    if (!field.rendersTokens) {
        return null;
    }

    return (
        <>
            <CopyPreview
                value={asText(value)}
                knownVariables={context.variables.map((variable) => variable.name)}
                mentions={mentions}
            />
            <VariablePicker
                variables={context.variables}
                requirements={context.requirements}
                value={asText(value)}
                onInsert={onAppend}
                channelLinks={channelLinks}
            />
        </>
    );
}

/** Append a token to existing copy, with a space when there is something to separate. */
export function withToken(current: string, token: string): string {
    return current && !current.endsWith(' ') ? `${current} ${token}` : `${current}${token}`;
}

/**
 * The value to emit for a text box the author has just emptied.
 *
 * `undefined` on an `optional` field, which removes the key — the same thing
 * `DurationControl` does with a cleared number, and for the same reason. A schema
 * reading `z.string().min(1).optional()` rejects `''`, so writing the empty string
 * would make `validateNodeData` refuse the entire save over a field whose own
 * description invited the author to leave it empty.
 *
 * A field that is not `optional` keeps writing `''`, because for it an empty box
 * is an unfinished value rather than a deliberate absence, and removing the key
 * would make the inspector forget what the author was editing.
 */
function emptyValueFor(field: TextField, next: string): string | undefined {
    return field.optional && !next ? undefined : next;
}

/** Single-line text. */
export function TextControl({ field, value, onChange, context, error }: ControlProps<TextField>) {
    return (
        <div>
            <TextInput
                label={field.label}
                description={limitHint(field)}
                placeholder={field.placeholder}
                maxLength={hardLimit(field)}
                error={error}
                value={asText(value)}
                onChange={(event) => onChange(emptyValueFor(field, event.currentTarget.value))}
            />
            {variableHints(field, value, context, (token) =>
                onChange(withToken(asText(value), token))
            )}
        </div>
    );
}

/**
 * The mention box's type and colour inside the inspector's own input frame: the frame's font,
 * its text colour, and the four rows the plain box starts at.
 */
const INSPECTOR_MENTION_TEXT: CSSProperties = {
    color: 'var(--input-color)',
    minHeight: 'calc(4em * var(--mantine-line-height))',
};

/**
 * Autosizing multi-line text — or, for a field whose text lands where Discord shows a mention
 * by name (`showsMentions`), the message window's mention box in the inspector's input frame:
 * `@` offers the server's roles, managed ones too, and `#` its text channels.
 */
export function LongTextControl({
    field,
    value,
    onChange,
    context,
    error,
}: ControlProps<LongTextField>) {
    const id = useId();
    const hint = limitHint(field);
    const { showsMentions } = field;
    const mentions = useMemo(
        () => (showsMentions ? mentionListsOf(context.roles, context.managedRoles, context.channels) : undefined),
        [showsMentions, context.roles, context.managedRoles, context.channels]
    );

    return (
        <div>
            {mentions ? (
                <Input.Wrapper id={id} label={field.label} description={hint} error={error}>
                    {/*
                     * The frame only: the box inside is the textarea, so the frame names nothing.
                     * No `maxLength`: the textarea holds the text as shown (`#general`), not as
                     * stored (`<#id>`), so a cap there would measure the wrong string — the
                     * server's re-check judges the length. It grows with its text, as the stage's does.
                     */}
                    <Input component="div" multiline withAria={false} error={error}>
                        <MentionTextarea
                            id={id}
                            // The ids `Input.Wrapper` gives its error and description, as the plain box is described.
                            describedBy={[error ? `${id}-error` : '', hint ? `${id}-description` : ''].join(' ').trim() || undefined}
                            invalid={!!error}
                            placeholder={field.placeholder}
                            value={asText(value)}
                            onChange={onChange}
                            textStyle={INSPECTOR_MENTION_TEXT}
                            mentions={mentions}
                        />
                    </Input>
                </Input.Wrapper>
            ) : (
                <Textarea
                    label={field.label}
                    description={hint}
                    placeholder={field.placeholder}
                    maxLength={hardLimit(field)}
                    error={error}
                    autosize
                    minRows={4}
                    maxRows={10}
                    value={asText(value)}
                    onChange={(event) => onChange(event.currentTarget.value)}
                />
            )}
            {variableHints(field, value, context, (token) => onChange(withToken(asText(value), token)), mentions)}
        </div>
    );
}
