/**
 * What the copy in this field will look like once the engine fills it in.
 *
 * Presentational: every decision about what a token becomes, and what counts as
 * worth mentioning, lives in `../copyPreview.ts` where it is testable without a
 * DOM. This renders the result and nothing else.
 */

import { Text } from '@mantine/core';
import { hasPreviewableTokens, previewCopy } from '../copyPreview';

interface CopyPreviewProps {
    /** The copy currently in the field. */
    value: string;
    /** Variables some upstream block writes, by name. */
    knownVariables: readonly string[];
}

export function CopyPreview({ value, knownVariables }: CopyPreviewProps) {
    // Nothing to add when the author can already read the result: a preview of
    // plain text is the field's own contents, printed twice.
    if (!hasPreviewableTokens(value)) {
        return null;
    }

    const { text, problems } = previewCopy(value, knownVariables);

    /*
     * Only unknown tokens are voiced here. A `{{var.…}}` nothing writes is already
     * reported by the picker below in yellow, and one mistake described twice
     * reads as two mistakes — so the preview shows it as a filled-in blank and
     * stays quiet. An unknown token has no other voice in the builder at all.
     */
    const unknown = problems.filter((problem) => problem.problem === 'unknownToken');

    return (
        <div style={{ marginTop: 6 }}>
            <Text size="10.5px" c="dimmed" fw={600} component="span">
                Preview:{' '}
            </Text>
            <Text
                size="11px"
                c="gray.4"
                component="span"
                style={{ fontFamily: 'var(--mantine-font-family-monospace)' }}
            >
                {text}
            </Text>

            {unknown.length > 0 ? (
                <Text size="10.5px" c="yellow.5" mt={4}>
                    {unknown.map((problem) => `{{${problem.token}}}`).join(', ')}{' '}
                    {unknown.length === 1 ? "isn't a token" : "aren't tokens"} a flow can fill in —
                    it&apos;ll be sent with the braces showing and fail the run.
                </Text>
            ) : null}
        </div>
    );
}
