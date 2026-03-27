import { describe, expect, it } from "vitest";
import { formatAgentFailureMessage } from "../src/agent/formatAgentFailureMessage.js";

describe("formatAgentFailureMessage", () => {
    it("uses bounded stderr/stdout without dumping full streams", () => {
        const huge = "e".repeat(50_000);
        const msg = formatAgentFailureMessage("agent", 1, huge, huge);
        expect(msg.length).toBeLessThan(3500);
        expect(msg).toContain("agent");
        expect(msg).toContain("exited 1");
        expect(msg).toContain("stderr:");
        expect(msg).toContain("stdout:");
    });

    it("points to diagnostics when both streams are empty", () => {
        const msg = formatAgentFailureMessage("orchestrator", 1, "  \n", "");
        expect(msg).toContain("no stderr/stdout");
        expect(msg).toContain("[github-plan]");
    });
});
