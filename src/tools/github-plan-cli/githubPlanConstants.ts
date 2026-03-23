/** Hidden marker for upserting the branch pin comment (must stay in body for lookup). */
export const BRANCH_PIN_MARKER = "<!-- github-plan-branch-pin:v1 -->";

/** First line of automation comments; omitted from model-facing thread context. */
export const AUTO_COMMENT_PREFIX_LINE = "<!-- github-plan:auto:v1 -->";

export const AUTO_COMMENT_PREFIX = `${AUTO_COMMENT_PREFIX_LINE}\n`;

export function withAutomationPrefix(body: string): string {
    const trimmed = body.trimStart();
    if (trimmed.startsWith(AUTO_COMMENT_PREFIX_LINE)) {
        return body;
    }
    return `${AUTO_COMMENT_PREFIX}${body}`;
}

/** True if this GitHub comment body should not appear in synthetic thread context for the agent. */
export function shouldExcludeCommentFromContext(body: string | null | undefined): boolean {
    if (body == null || body === "") {
        return true;
    }
    const trimmed = body.trimStart();
    if (trimmed.startsWith(AUTO_COMMENT_PREFIX_LINE)) {
        return true;
    }
    if (body.includes(BRANCH_PIN_MARKER)) {
        return true;
    }
    return false;
}
