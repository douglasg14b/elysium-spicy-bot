import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");

/** Raw markdown from `github-plan-cli/prompts/` (no variable block or placeholder substitution). */
export function readPromptFile(relativeFileName: string): string {
    const filePath = join(promptsDir, relativeFileName);
    return readFileSync(filePath, "utf8");
}

/** Prefix variable assignments for model-visible context (tmp-style). */
export function buildVariableBlock(variables: Record<string, string>): string {
    const lines = Object.entries(variables).map(([key, value]) => `${key}: ${value}`);
    return `${lines.join("\n")}\n\n---\n\n`;
}

/**
 * Load a markdown prompt from `github-plan-cli/prompts/` and inject `{{NAME}}` placeholders.
 */
export function loadPrompt(relativeFileName: string, variables: Record<string, string>): string {
    const filePath = join(promptsDir, relativeFileName);
    let content = readFileSync(filePath, "utf8");
    for (const [key, value] of Object.entries(variables)) {
        const token = `{{${key}}}`;
        content = content.split(token).join(value);
    }
    return buildVariableBlock(variables) + content;
}
