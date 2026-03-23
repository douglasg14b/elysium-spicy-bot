/** Workspace-relative directory for Jarvis (GitHub plan) scratch files passed to the agent CLI. */
export const JARVIS_WORKSPACE_DIR = ".jarvis";

/** Intent JSON written here by the intent-detector agent; read by `classify intent` (runner-local, not committed). */
export const JARVIS_INTENT_RESULT_FILENAME = "intent-result.json";

export function workspaceRoot(): string {
    return process.env.GITHUB_WORKSPACE ?? process.cwd();
}

/** Model passed to `agent --model` (intent + planner). */
export function agentModelFromEnv(): string {
    return process.env.JARVIS_AGENT_MODEL ?? process.env.CURSOR_AGENT_MODEL ?? "auto";
}

/**
 * Effective Cursor Cloud API key: `CURSOR_API_KEY`, or `JARVIS_API_KEY` when the former is unset or blank.
 */
export function cursorApiKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const fromCursor = env.CURSOR_API_KEY?.trim();
    if (fromCursor) {
        return fromCursor;
    }
    const fromJarvis = env.JARVIS_API_KEY?.trim();
    return fromJarvis || undefined;
}

export function assertCursorAgentApiKeyConfigured(): void {
    if (!cursorApiKeyFromEnv()) {
        throw new Error(
            "Missing Cursor agent API key: set CURSOR_API_KEY or JARVIS_API_KEY in the environment. Repository secrets alone are not visible to the job unless the workflow maps them (e.g. CURSOR_API_KEY: ${{ secrets.CURSOR_API_KEY }}).",
        );
    }
}

/**
 * Environment for spawning the Cursor `agent` CLI. Ensures `CURSOR_API_KEY` is set when a key was provided under either name.
 */
export function agentSubprocessEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    const key = cursorApiKeyFromEnv(env);
    if (key) {
        env.CURSOR_API_KEY = key;
    }
    return env;
}
