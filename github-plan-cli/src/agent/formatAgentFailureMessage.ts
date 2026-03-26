const MAX_SNIPPET = 240;
const MAX_EACH_STREAM_PREFIX = 160;

/**
 * Short error line for agent failures: bounded stderr/stdout prefixes (no full stream concat).
 */
export function formatAgentFailureMessage(label: string, status: number | null, stderr: string, stdout: string): string {
    const stderrPart =
        stderr.length > MAX_EACH_STREAM_PREFIX
            ? `${stderr.slice(0, MAX_EACH_STREAM_PREFIX)}…`
            : stderr;
    const stdoutPart =
        stdout.length > MAX_EACH_STREAM_PREFIX
            ? `${stdout.slice(0, MAX_EACH_STREAM_PREFIX)}…`
            : stdout;
    const combined = `${stderrPart} ${stdoutPart}`.trim().replace(/\s+/g, " ");
    const snippet = combined.length > MAX_SNIPPET ? `${combined.slice(0, MAX_SNIPPET)}…` : combined;
    const statusPart = status === null ? "spawn failed" : `exited ${String(status)}`;
    if (snippet) {
        return `${label} ${statusPart}: ${snippet}`;
    }
    return `${label} ${statusPart}`;
}
