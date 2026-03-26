import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CursorAgentSpawnResult } from "../src/agent/cursorAgentSpawn.js";
import * as loadPromptModule from "../src/prompts/loadPrompt.js";
import { runPlanLocal } from "../src/plan/runPlanLocal.js";

describe("runPlanLocal", () => {
    let workDir: string;

    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), "gh-plan-local-"));
        vi.stubEnv("GITHUB_WORKSPACE", workDir);
        vi.stubEnv("GITHUB_PLAN_DEBUG", "0");
        vi.stubEnv("CURSOR_API_KEY", "test-key-for-local-module");
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        rmSync(workDir, { recursive: true, force: true });
    });

    it("writes intent-context, invokes planner, requires plan.md", async () => {
        const mockResult: CursorAgentSpawnResult = {
            exitCode: 0,
            durationMs: 1,
            rawStdout: "{}",
            rawStderr: "",
            usage: undefined,
            assistantTranscript: "",
            outputFormat: "json",
        };
        const spawnPlanner = vi.fn(async (options) => {
            expect(options.mode).toBe("plan");
            expect(options.workspaceRoot).toBe(workDir);
            expect(options.prompt).toContain(".jarvis/intent-context.md");
            expect(options.prompt).toContain(".jarvis/plan.md");
            writeFileSync(join(workDir, ".jarvis", "plan.md"), "# Local test plan\n", "utf8");
            return mockResult;
        });

        const { planPath } = await runPlanLocal(
            { contextMarkdown: "## Issue\nHello" },
            { spawnPlanner },
        );

        expect(planPath).toBe(join(workDir, ".jarvis", "plan.md"));
        expect(readFileSync(join(workDir, ".jarvis", "intent-context.md"), "utf8")).toBe("## Issue\nHello");
        expect(spawnPlanner).toHaveBeenCalledOnce();
    });

    it("loads planner-revise.md when isPlanFeedbackRun", async () => {
        const loadSpy = vi.spyOn(loadPromptModule, "loadPrompt").mockImplementation((name, vars) => {
            return `stub:${name}:${vars.INTENT_CONTEXT_PATH ?? ""}`;
        });

        const mockResult: CursorAgentSpawnResult = {
            exitCode: 0,
            durationMs: 1,
            rawStdout: "{}",
            rawStderr: "",
            usage: undefined,
            assistantTranscript: "",
            outputFormat: "json",
        };
        const spawnPlanner = vi.fn(async () => {
            writeFileSync(join(workDir, ".jarvis", "plan.md"), "# revised\n", "utf8");
            return mockResult;
        });

        await runPlanLocal({ contextMarkdown: "ctx", isPlanFeedbackRun: true }, { spawnPlanner });

        expect(loadSpy).toHaveBeenCalledWith(
            "planner-revise.md",
            expect.objectContaining({
                INTENT_CONTEXT_PATH: ".jarvis/intent-context.md",
                PLAN_OUTPUT_PATH: ".jarvis/plan.md",
            }),
        );
    });
});
