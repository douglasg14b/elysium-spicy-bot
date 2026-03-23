/** Workspace-relative directory for Jarvis (GitHub plan) scratch files passed to the agent CLI. */
export const JARVIS_WORKSPACE_DIR = ".jarvis";

export function workspaceRoot(): string {
    return process.env.GITHUB_WORKSPACE ?? process.cwd();
}

/** Model passed to `agent --model` (intent + planner). */
export function agentModelFromEnv(): string {
    return process.env.JARVIS_AGENT_MODEL ?? process.env.CURSOR_AGENT_MODEL ?? "auto";
}

/**
 * Environment for spawning the Cursor `agent` CLI. Maps Jarvis-prefixed secrets to vars the binary expects.
 */
export function agentSubprocessEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (env.JARVIS_API_KEY && !env.CURSOR_API_KEY) {
        env.CURSOR_API_KEY = env.JARVIS_API_KEY;
    }
    return env;
}
