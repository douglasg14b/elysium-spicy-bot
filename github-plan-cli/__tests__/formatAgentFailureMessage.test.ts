import { describe, expect, it } from "vitest";
import { formatAgentFailureMessage } from "../src/agent/formatAgentFailureMessage.js";

describe("formatAgentFailureMessage", () => {
    it("uses bounded stderr/stdout prefixes without allocating full concat", () => {
        const huge = "e".repeat(50_000);
        const msg = formatAgentFailureMessage("agent", 1, huge, huge);
        expect(msg.length).toBeLessThan(500);
        expect(msg).toContain("agent");
        expect(msg).toContain("exited 1");
    });
});
