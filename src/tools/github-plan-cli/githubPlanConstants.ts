/**
 * Allowed `intent` strings from the intent-detector skill JSON output.
 * Single source of truth — keep aligned with `.cursor/skills/intent-detector/SKILL.md`.
 */
export const DETECTOR_INTENT_VALUES = ["plan", "plan_feedback", "implement", "other"] as const;
export type DetectorIntent = (typeof DETECTOR_INTENT_VALUES)[number];
export const DETECTOR_INTENT_SET: ReadonlySet<DetectorIntent> = new Set(DETECTOR_INTENT_VALUES);

export function isDetectorIntent(value: string): value is DetectorIntent {
    return DETECTOR_INTENT_SET.has(value as DetectorIntent);
}

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
