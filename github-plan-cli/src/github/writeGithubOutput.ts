import { appendFileSync } from "node:fs";

/**
 * Append a line to GITHUB_OUTPUT when running inside GitHub Actions.
 */
export function writeGithubOutput(key: string, value: string): void {
    const path = process.env.GITHUB_OUTPUT;
    if (!path) return;
    const safe = value.replace(/\r?\n/g, "\n");
    appendFileSync(path, `${key}=${safe}\n`, "utf8");
}
