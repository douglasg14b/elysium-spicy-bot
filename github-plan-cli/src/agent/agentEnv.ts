/** Workspace-relative directory for Jarvis (GitHub plan) scratch files passed to the agent CLI. */
export const JARVIS_WORKSPACE_DIR = ".jarvis";

/** OpenAI API key for intent classification (`classify intent`). */
export function openaiApiKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const key = env.OPENAI_API_KEY?.trim();
    return key || undefined;
}

const OPENAI_KEY_MISSING_MESSAGE =
    "Missing OpenAI API key: set OPENAI_API_KEY in the environment. For GitHub Actions, map the repository secret (e.g. OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}).";

/** Returns `OPENAI_API_KEY` or throws with setup guidance. */
export function requireOpenAiApiKey(env: NodeJS.ProcessEnv = process.env): string {
    const key = openaiApiKeyFromEnv(env);
    if (!key) {
        throw new Error(OPENAI_KEY_MISSING_MESSAGE);
    }
    return key;
}

export function assertOpenAiApiKeyConfigured(): void {
    requireOpenAiApiKey();
}

export function workspaceRoot(): string {
    return process.env.GITHUB_WORKSPACE ?? process.cwd();
}

/** Model passed to `agent --model` (plan generation). */
export function agentModelFromEnv(): string {
    return process.env.JARVIS_AGENT_MODEL ?? process.env.CURSOR_AGENT_MODEL ?? "auto";
}

/**
 * Optional wall-clock limit for the Cursor `agent` subprocess (milliseconds).
 * Set `JARVIS_AGENT_TIMEOUT_MS` in CI to cap wall time before the child is killed (Jarvis workflows default to one hour).
 */
export function cursorAgentTimeoutMsFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
    const raw = env.JARVIS_AGENT_TIMEOUT_MS?.trim();
    if (!raw) {
        return undefined;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(
            "JARVIS_AGENT_TIMEOUT_MS must be a positive integer (milliseconds), e.g. 3600000 for one hour.",
        );
    }
    return parsed;
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
