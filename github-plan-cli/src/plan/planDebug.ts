import { envValueIsExplicitlyOff } from "../config/envTruthy.js";

/**
 * Whether to emit `[github-plan:debug]` lines on stderr.
 *
 * **On by default** (local and CI). Set `GITHUB_PLAN_DEBUG` to `0`, `false`, `no`, or `off` to disable.
 */
export function isPlanCliDebugEnabled(): boolean {
    return !envValueIsExplicitlyOff(process.env.GITHUB_PLAN_DEBUG);
}

/** Max characters of comment body included in debug JSON (remainder summarized). */
export const PLAN_DEBUG_MAX_COMMENT_BODY_CHARS = 12_000;

export function truncateForPlanDebug(
    text: string,
    maxChars: number = PLAN_DEBUG_MAX_COMMENT_BODY_CHARS,
): string {
    if (text.length <= maxChars) {
        return text;
    }
    return `${text.slice(0, maxChars)}… [truncated, ${String(text.length)} chars total]`;
}

export function planDebugLog(
    message: string,
    details?: Record<string, string | number | boolean | undefined>,
): void {
    if (!isPlanCliDebugEnabled()) {
        return;
    }
    const suffix =
        details !== undefined && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : "";
    console.error(`[github-plan:debug] ${message}${suffix}`);
}
