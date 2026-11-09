import { MODEL_PROVIDERS } from "@openrhen/contracts";
import { describe, expect, it, vi } from "vitest";
import { createPolicyState, type PolicyDeps } from "./call-policy";
import { SYNTHETIC_TEST_TEXT, runConnectionTest } from "./connection-test";

const deps = (reply: unknown): { policy: PolicyDeps; sent: string[] } => {
  const sent: string[] = [];
  return {
    sent,
    policy: {
      hosted: MODEL_PROVIDERS.hosted,
      transport: {
        complete: vi.fn(async (_tier, request) => {
          sent.push(request.messages.map((m: { content: string }) => m.content).join("\n"));
          return reply as never;
        })
      },
      settings: { t3DailyMessageCap: 50, t3DailyTokenCap: 200_000 },
      usage: async () => ({ messages: 0, tokens: 0 }),
      recordCall: vi.fn(async () => {}),
      isHostedEligible: vi.fn(async () => ({ eligible: false as const, reason: "must not be asked" })),
      sleep: async () => {},
      state: createPolicyState()
    }
  };
};
const good = { outcome: "ok", text: '{"ok":true}', model: "m", tokensIn: 10, tokensOut: 3 };

describe("connection test", () => {
  it("sends only the fixed synthetic text, never mail", async () => {
    const { policy, sent } = deps(good);
    const result = await runConnectionTest(policy, "t2", "qwen3:8b");
    expect(result).toMatchObject({ ok: true, tier: "t2" });
    expect(sent.join("\n")).toContain(SYNTHETIC_TEST_TEXT);
    expect(SYNTHETIC_TEST_TEXT).toContain("synthetic");
  });

  it("does not ask the mail-eligibility rule, because no mail is sent, but still writes the audit row for a hosted send", async () => {
    const { policy } = deps(good);
    const result = await runConnectionTest(policy, "t3", "Qwen/Qwen3-14B");
    expect(result.ok).toBe(true);
    expect(policy.isHostedEligible).not.toHaveBeenCalled();
    expect(policy.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({ sourceEventKey: "test:synthetic", tier: "t3" })
    );
  });

  it("reports a failure with the proxy's sentence and what was tried", async () => {
    const { policy } = deps({ outcome: "unreachable", message: "Could not connect to Ollama at 10.0.0.5:11434." });
    const result = await runConnectionTest(policy, "t2", "qwen3:8b");
    expect(result).toMatchObject({
      ok: false,
      outcome: "unreachable",
      message: "Could not connect to Ollama at 10.0.0.5:11434."
    });
  });

  it("says a model must be chosen first", async () => {
    const { policy } = deps(good);
    expect(await runConnectionTest(policy, "t2", null)).toMatchObject({ ok: false, outcome: "no_model" });
    expect(policy.transport.complete).not.toHaveBeenCalled();
  });

  it("surfaces a refusal (cap reached) as a failed test with the reason", async () => {
    const { policy } = deps(good);
    policy.settings.t3DailyMessageCap = 0;
    expect(await runConnectionTest(policy, "t3", "Qwen/Qwen3-14B")).toMatchObject({
      ok: false,
      outcome: "message_cap"
    });
  });

  it("fails when the model answered but not with the JSON asked for", async () => {
    const { policy } = deps({ ...good, text: "hello" });
    expect(await runConnectionTest(policy, "t2", "m")).toMatchObject({ ok: false, outcome: "bad_output" });
  });
});
