const MAX_SNIPPET = 240;

/** Safe error line for agent failures: avoid dumping full stdout/stderr (may include paths). */
export function formatAgentFailureMessage(label: string, status: number | null, stderr: string, stdout: string): string {
    const combined = `${stderr}${stdout}`.trim().replace(/\s+/g, " ");
    const snippet = combined.length > MAX_SNIPPET ? `${combined.slice(0, MAX_SNIPPET)}…` : combined;
    const statusPart = status === null ? "spawn failed" : `exited ${String(status)}`;
    if (snippet) {
        return `${label} ${statusPart}: ${snippet}`;
    }
    return `${label} ${statusPart}`;
}
