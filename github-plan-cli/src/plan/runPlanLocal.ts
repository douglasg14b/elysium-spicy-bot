import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    assertCursorAgentApiKeyConfigured,
    JARVIS_WORKSPACE_DIR,
    workspaceRoot,
} from "../agent/agentEnv.js";
import {
    assertCursorAgentSucceeded,
    spawnCursorAgent,
    type CursorAgentSpawnResult,
    type SpawnCursorAgentOptions,
} from "../agent/cursorAgentSpawn.js";
import { loadPrompt } from "../prompts/loadPrompt.js";
import { recordAgentTelemetryStep } from "../telemetry/recordAgentTelemetryStep.js";
import { planDebugLog } from "./planDebug.js";

export type RunPlanLocalInput = {
    contextMarkdown: string;
    isPlanFeedbackRun?: boolean;
};

export type RunPlanLocalDeps = {
    spawnPlanner?: (options: SpawnCursorAgentOptions) => Promise<CursorAgentSpawnResult>;
};

function readPlanOutputFileOrThrow(planPath: string, relativeLabel: string): void {
    let text: string;
    try {
        text = readFileSync(planPath, "utf8");
    } catch {
        throw new Error(
            `Planner did not produce ${relativeLabel}; the agent must Write the plan to that path.`,
        );
    }
    if (!text.trim()) {
        throw new Error(`ERROR: ${relativeLabel} is empty after planner run`);
    }
}

/**
 * Run the Cursor planner from local markdown context only (no GitHub API, no git).
 */
export async function runPlanLocal(
    input: RunPlanLocalInput,
    deps: RunPlanLocalDeps = {},
): Promise<{ planPath: string }> {
    assertCursorAgentApiKeyConfigured();
    const root = workspaceRoot();
    const jarvisDir = join(root, JARVIS_WORKSPACE_DIR);
    mkdirSync(jarvisDir, { recursive: true });
    writeFileSync(join(jarvisDir, "intent-context.md"), input.contextMarkdown, "utf8");

    planDebugLog("runPlanLocal: wrote intent-context.md", {
        markdownChars: input.contextMarkdown.length,
    });

    const intentContextPath = `${JARVIS_WORKSPACE_DIR}/intent-context.md`;
    const planOutputPath = `${JARVIS_WORKSPACE_DIR}/plan.md`;
    const planPath = join(root, JARVIS_WORKSPACE_DIR, "plan.md");

    const isPlanFeedbackRun = input.isPlanFeedbackRun ?? false;
    const promptFile = isPlanFeedbackRun ? "planner-revise.md" : "planner-new.md";
    const prompt = loadPrompt(promptFile, {
        INTENT_CONTEXT_PATH: intentContextPath,
        PLAN_OUTPUT_PATH: planOutputPath,
    });

    planDebugLog("runPlanLocal: spawning Cursor agent (planner)", {
        promptFile,
        promptChars: prompt.length,
    });

    const spawnPlanner = deps.spawnPlanner ?? spawnCursorAgent;
    const agentResult = await spawnPlanner({
        name: "planner",
        workspaceRoot: root,
        mode: "plan",
        prompt,
    });

    assertCursorAgentSucceeded("agent (planner)", agentResult);

    planDebugLog("runPlanLocal: Cursor agent finished", {
        exitCode: agentResult.exitCode,
        durationMs: agentResult.durationMs,
    });

    recordAgentTelemetryStep({
        name: "Implementation plan (Cursor agent, local)",
        durationMs: agentResult.durationMs,
        usage: agentResult.usage,
    });

    readPlanOutputFileOrThrow(planPath, planOutputPath);

    return { planPath };
}
