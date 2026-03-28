const MAX_STDERR_IN_MESSAGE = 8_000;
const MAX_STDOUT_IN_MESSAGE = 8_000;

/**
 * Error line for agent failures: bounded stderr/stdout (no full stream concat).
 * Prefer stderr; include stdout when useful. When both empty, point to the diagnostic block.
 */
export function formatAgentFailureMessage(
    label: string,
    status: number | null,
    stderr: string,
    stdout: string,
): string {
    const statusPart = status === null ? "spawn failed" : `exited ${String(status)}`;
    const stderrTrim = stderr.trim();
    const stdoutTrim = stdout.trim();
    const stderrPart =
        stderrTrim.length > MAX_STDERR_IN_MESSAGE
            ? `${stderrTrim.slice(0, MAX_STDERR_IN_MESSAGE)}…`
            : stderrTrim;
    const stdoutPart =
        stdoutTrim.length > MAX_STDOUT_IN_MESSAGE
            ? `${stdoutTrim.slice(0, MAX_STDOUT_IN_MESSAGE)}…`
            : stdoutTrim;

    const parts: string[] = [`${label} ${statusPart}`];
    if (stderrPart) {
        parts.push(`stderr: ${stderrPart}`);
    }
    if (stdoutPart) {
        parts.push(`stdout: ${stdoutPart}`);
    }
    if (!stderrPart && !stdoutPart) {
        parts.push("(no stderr/stdout; see preceding [github-plan] Cursor agent failed block on stderr)");
    }
    return parts.join(" | ");
}
