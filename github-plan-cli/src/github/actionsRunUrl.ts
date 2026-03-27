/**
 * Build the GitHub Actions run URL for the current job (CI only).
 */
export function githubActionsRunUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
    const serverRaw = env.GITHUB_SERVER_URL?.trim() ?? "";
    const server = serverRaw.replace(/\/$/, "");
    const repoSlug = env.GITHUB_REPOSITORY?.trim() ?? "";
    const runId = env.GITHUB_RUN_ID?.trim() ?? "";
    if (!server || !repoSlug || !runId) {
        throw new Error(
            "GITHUB_SERVER_URL, GITHUB_REPOSITORY, and GITHUB_RUN_ID must be set to build the workflow run URL.",
        );
    }
    return `${server}/${repoSlug}/actions/runs/${runId}`;
}
