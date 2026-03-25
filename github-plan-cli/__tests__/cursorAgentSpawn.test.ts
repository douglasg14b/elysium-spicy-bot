import { describe, expect, it } from "vitest";
import { parseCursorAgentJsonOutput } from "../src/agent/cursorAgentSpawn.js";

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
