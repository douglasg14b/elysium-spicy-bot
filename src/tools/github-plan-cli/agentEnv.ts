export function workspaceRoot(): string {
    return process.env.GITHUB_WORKSPACE ?? process.cwd();
}

/** Model passed to `agent --model` (intent + planner). */
export function agentModelFromEnv(): string {
    return process.env.CURSOR_AGENT_MODEL ?? "auto";
}
