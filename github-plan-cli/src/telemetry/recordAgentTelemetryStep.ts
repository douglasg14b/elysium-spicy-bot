import { appendFileSync } from "node:fs";
import type { CursorAgentUsage } from "../agent/cursorAgentSpawn.js";
import { planDebugLog } from "../plan/planDebug.js";

export type AgentTelemetryStep = {
    name: string;
    durationMs: number;
    usage: CursorAgentUsage | undefined;
};

function formatStepMarkdown(step: AgentTelemetryStep): string {
    const lines = [`### ${step.name}`, `- Duration: ${String(step.durationMs)} ms`];
    if (step.usage) {
        lines.push(
            `- Tokens: ${String(step.usage.inputTokens)} in / ${String(step.usage.outputTokens)} out (cache read: ${String(step.usage.cacheReadTokens)}, cache write: ${String(step.usage.cacheCreationTokens)})`,
        );
        if (step.usage.costUsd > 0) {
            lines.push(`- Cost (reported): $${step.usage.costUsd.toFixed(4)}`);
        }
    } else {
        lines.push("- Usage: (not present in CLI JSON)");
    }
    return `${lines.join("\n")}\n\n`;
}

/**
 * Append one step to `GITHUB_STEP_SUMMARY` when running in Actions; always mirror to plan debug when enabled.
 */
export function recordAgentTelemetryStep(step: AgentTelemetryStep): void {
    const details: Record<string, string | number | boolean | undefined> = {
        name: step.name,
        durationMs: step.durationMs,
    };
    if (step.usage) {
        details.inputTokens = step.usage.inputTokens;
        details.outputTokens = step.usage.outputTokens;
        details.costUsd = step.usage.costUsd;
    }
    planDebugLog("agent telemetry", details);

    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) {
        try {
            appendFileSync(summaryPath, formatStepMarkdown(step), "utf8");
        } catch {
            /* non-fatal */
        }
    }
}
