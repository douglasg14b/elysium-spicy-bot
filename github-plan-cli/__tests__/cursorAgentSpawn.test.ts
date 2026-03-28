import { afterEach, describe, expect, it, vi } from "vitest";
import {
    buildCursorAgentArgv,
    cursorAgentStdoutFormatFromPlanDebug,
    parseCursorAgentJsonOutput,
    parseCursorAgentResultPayload,
    parseCursorAgentStdoutSnapshot,
} from "../src/agent/cursorAgentSpawn.js";

describe("parseCursorAgentJsonOutput", () => {
    it("extracts result and snake_case usage", () => {
        const stdout = JSON.stringify({
            result: "ok",
            usage: {
                input_tokens: 10,
                output_tokens: 20,
                cache_read_input_tokens: 3,
                cache_creation_input_tokens: 1,
            },
            total_cost_usd: 0.05,
        });
        const parsed = parseCursorAgentJsonOutput(stdout);
        expect(parsed.assistantTranscript).toBe("ok");
        expect(parsed.usage).toEqual({
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 3,
            cacheCreationTokens: 1,
            costUsd: 0.05,
        });
    });

    it("returns raw text when JSON parse fails", () => {
        const parsed = parseCursorAgentJsonOutput("not json");
        expect(parsed.assistantTranscript).toBe("not json");
        expect(parsed.usage).toBeUndefined();
    });

    it("treats all-zero usage as undefined", () => {
        const stdout = JSON.stringify({ result: "x", usage: {} });
        const parsed = parseCursorAgentJsonOutput(stdout);
        expect(parsed.usage).toBeUndefined();
    });
});

describe("parseCursorAgentResultPayload", () => {
    it("matches stream-json terminal result shape from Cursor CLI docs", () => {
        const terminal = {
            type: "result",
            subtype: "success",
            duration_ms: 5234,
            is_error: false,
            result: "full assistant text",
            session_id: "uuid",
        };
        const parsed = parseCursorAgentResultPayload(terminal);
        expect(parsed.assistantTranscript).toBe("full assistant text");
        expect(parsed.usage).toBeUndefined();
    });

    it("extracts usage from terminal result when present", () => {
        const terminal = {
            type: "result",
            result: "ok",
            usage: {
                input_tokens: 1,
                output_tokens: 2,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
            },
            total_cost_usd: 0.01,
        };
        const parsed = parseCursorAgentResultPayload(terminal);
        expect(parsed.assistantTranscript).toBe("ok");
        expect(parsed.usage?.inputTokens).toBe(1);
        expect(parsed.usage?.outputTokens).toBe(2);
        expect(parsed.usage?.costUsd).toBe(0.01);
    });

    it("uses nested message content when result is absent", () => {
        const parsed = parseCursorAgentResultPayload({
            type: "result",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "from nested" }],
            },
        });
        expect(parsed.assistantTranscript).toBe("from nested");
    });
});

describe("cursorAgentStdoutFormatFromPlanDebug", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("uses json when GITHUB_PLAN_DEBUG opts out", () => {
        vi.stubEnv("GITHUB_PLAN_DEBUG", "0");
        vi.stubEnv("GITHUB_ACTIONS", "");
        expect(cursorAgentStdoutFormatFromPlanDebug()).toBe("json");
    });

    it("uses stream-json when debug is default (unset) outside Actions", () => {
        vi.stubEnv("GITHUB_PLAN_DEBUG", "");
        vi.stubEnv("GITHUB_ACTIONS", "");
        expect(cursorAgentStdoutFormatFromPlanDebug()).toBe("stream-json");
    });

    it("uses json on GitHub Actions when GITHUB_PLAN_DEBUG is unset", () => {
        vi.stubEnv("GITHUB_PLAN_DEBUG", "");
        vi.stubEnv("GITHUB_ACTIONS", "true");
        expect(cursorAgentStdoutFormatFromPlanDebug()).toBe("json");
    });

    it("uses stream-json on GitHub Actions when GITHUB_PLAN_DEBUG is explicitly on", () => {
        vi.stubEnv("GITHUB_PLAN_DEBUG", "1");
        vi.stubEnv("GITHUB_ACTIONS", "true");
        expect(cursorAgentStdoutFormatFromPlanDebug()).toBe("stream-json");
    });
});

describe("buildCursorAgentArgv", () => {
    const baseOptions = {
        name: "t",
        workspaceRoot: "C:\\repo",
        mode: "plan" as const,
        prompt: "hello",
    };

    it("includes --output-format json or stream-json", () => {
        const jsonArgv = buildCursorAgentArgv(baseOptions, "json");
        const idx = jsonArgv.indexOf("--output-format");
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(jsonArgv[idx + 1]).toBe("json");

        const streamArgv = buildCursorAgentArgv(baseOptions, "stream-json");
        const streamIdx = streamArgv.indexOf("--output-format");
        expect(streamArgv[streamIdx + 1]).toBe("stream-json");
    });

    it("omits --stream-partial-output unless GITHUB_PLAN_STREAM_PARTIAL is truthy", () => {
        vi.stubEnv("GITHUB_PLAN_STREAM_PARTIAL", "");
        const withoutPartial = buildCursorAgentArgv(baseOptions, "stream-json");
        expect(withoutPartial).not.toContain("--stream-partial-output");

        vi.stubEnv("GITHUB_PLAN_STREAM_PARTIAL", "1");
        const withPartial = buildCursorAgentArgv(baseOptions, "stream-json");
        expect(withPartial).toContain("--stream-partial-output");
        vi.unstubAllEnvs();
    });

    it("passes --force on GitHub Actions only", () => {
        vi.stubEnv("GITHUB_ACTIONS", "");
        expect(buildCursorAgentArgv(baseOptions, "json")).not.toContain("--force");

        vi.stubEnv("GITHUB_ACTIONS", "true");
        expect(buildCursorAgentArgv(baseOptions, "json")).toContain("--force");
        vi.unstubAllEnvs();
    });

    it("omits --mode when mode is agent (CLI default is agent)", () => {
        const argv = buildCursorAgentArgv({ ...baseOptions, mode: "agent" }, "json");
        expect(argv.filter((a) => a === "--mode")).toHaveLength(0);
    });
});

describe("parseCursorAgentStdoutSnapshot", () => {
    it("scans NDJSON for terminal result when live pointer was lost (stream-json)", () => {
        const stdout =
            '{"type":"assistant","message":{"role":"a","content":[{"type":"text","text":"x"}]}}\n' +
            '{"type":"result","result":"from-scan","duration_ms":1}\n';
        const parsed = parseCursorAgentStdoutSnapshot(stdout, "stream-json", undefined);
        expect(parsed.assistantTranscript).toBe("from-scan");
    });

    it("returns empty transcript for stream-json with no terminal result", () => {
        const stdout = '{"type":"assistant","message":{"role":"a","content":[]}}\n';
        const parsed = parseCursorAgentStdoutSnapshot(stdout, "stream-json", undefined);
        expect(parsed.assistantTranscript).toBe("");
        expect(parsed.usage).toBeUndefined();
    });

    it("uses single-json parse for json format", () => {
        const stdout = JSON.stringify({ result: "one-shot" });
        expect(parseCursorAgentStdoutSnapshot(stdout, "json", undefined).assistantTranscript).toBe("one-shot");
    });
});
