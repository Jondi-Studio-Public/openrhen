import type { ModelProviderDescriptor } from "@openrhen/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  callModel,
  createPolicyState,
  estimateTokens,
  hostedModelRefusal,
  type ModelOutcome,
  type PolicyDeps,
  type PolicyRequest
} from "./call-policy";

/** A made-up provider: the policy must work from this descriptor alone, with no knowledge of any real vendor. */
const FAKE_HOSTED: ModelProviderDescriptor = {
  tier: "hosted",
  connectionId: "fake-host",
  label: "AcmeAI",
  secretName: "hosted_model_api_key",
  body: { keyField: "token" },
  refusedOrgs: { widgetco: "WidgetCo" },
  refusalMessage: (model, org) => `ACME REFUSES ${model} (${org})`
};

const ok = (text = '{"a":1}', tokensIn: number | null = 100, tokensOut: number | null = 20): ModelOutcome => ({
  outcome: "ok",
  text,
  model: "m",
  tokensIn,
  tokensOut
});
const bad = (outcome: Exclude<ModelOutcome["outcome"], "ok">, message = "x"): ModelOutcome => ({ outcome, message });

function setup(overrides: Partial<PolicyDeps> = {}, sends: ModelOutcome[] = [ok()]) {
  const queue = [...sends];
  const calls: { tier: string; model: string; messages: { role: string; content: string }[]; maxTokens: number }[] = [];
  const recorded: Parameters<PolicyDeps["recordCall"]>[0][] = [];
  const sleeps: number[] = [];
  const deps: PolicyDeps = {
    hosted: FAKE_HOSTED,
    transport: {
      complete: vi.fn(async (tier, request) => {
        calls.push({ tier, ...request });
        return queue.shift() ?? ok();
      })
    },
    settings: { t3DailyMessageCap: 50, t3DailyTokenCap: 200_000 },
    usage: vi.fn(async () => ({ messages: 0, tokens: 0 })),
    recordCall: vi.fn(async (row) => {
      recorded.push(row);
    }),
    isHostedEligible: vi.fn(async () => ({ eligible: true as const })),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    state: createPolicyState(),
    ...overrides
  };
  return { deps, calls, recorded, sleeps };
}

const t2: PolicyRequest = {
  tier: "t2",
  sourceEventKey: "mail:1",
  model: "qwen3:8b",
  messages: [{ role: "user", content: "hello" }],
  maxTokens: 200
};
const t3: PolicyRequest = { ...t2, tier: "t3", model: "Qwen/Qwen3-14B" };

describe("local tier", () => {
  it("warms the model once, then sends the real call, and warms again only for a different model", async () => {
    const { deps, calls } = setup({}, [ok("OK", 5, 1), ok(), ok()]);
    const first = await callModel(deps, t2);
    expect(first.kind).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.maxTokens).toBeLessThanOrEqual(8);
    expect(calls[0]!.messages.map((m) => m.content).join(" ")).not.toContain("hello");
    expect(calls[1]!.messages[0]!.content).toBe("hello");
    await callModel(deps, t2);
    expect(calls).toHaveLength(3);
    await callModel(deps, { ...t2, model: "other:1b" });
    expect(calls).toHaveLength(5);
  });

  it("retries a timeout twice with growing waits, then gives up with the proxy's words", async () => {
    const { deps, calls, sleeps } = setup({}, [
      ok("OK"),
      bad("timeout", "slow"),
      bad("timeout", "slow"),
      bad("timeout", "slow")
    ]);
    const result = await callModel(deps, t2);
    expect(result).toMatchObject({ kind: "failed", outcome: "timeout", message: "slow" });
    expect(calls).toHaveLength(4);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!);
  });

  it("succeeds when the second try answers", async () => {
    const { deps } = setup({}, [ok("OK"), bad("timeout"), ok('{"z":1}')]);
    expect(await callModel(deps, t2)).toMatchObject({ kind: "ok", text: '{"z":1}' });
  });

  it("does not retry unreachable, rate_limited or bad_key", async () => {
    for (const outcome of ["unreachable", "rate_limited", "bad_key"] as const) {
      const { deps, calls } = setup({}, [bad(outcome, "no")]);
      const result = await callModel(deps, t2);
      expect(result).toMatchObject({ kind: "failed", outcome });
      // Unreachable on the warm-up stops there; the real call is never made.
      expect(calls).toHaveLength(1);
    }
  });

  it("repairs bad output once, with a reminder, and no more", async () => {
    const { deps, calls } = setup({}, [ok("OK"), bad("bad_output"), bad("bad_output")]);
    const result = await callModel(deps, t2);
    expect(result).toMatchObject({ kind: "failed", outcome: "bad_output" });
    expect(calls).toHaveLength(3);
    const repair = calls[2]!.messages;
    expect(repair.length).toBe(calls[1]!.messages.length + 1);
    expect(repair.at(-1)!.content.toLowerCase()).toContain("json");
  });

  it("treats output the caller's validator refuses as bad output, and repairs once", async () => {
    const validate = vi.fn((text: string) => (text.includes("fixed") ? null : "missing the fixed key"));
    const { deps, calls } = setup({}, [ok("OK"), ok("nope"), ok("fixed")]);
    const result = await callModel(deps, { ...t2, validate });
    expect(result).toMatchObject({ kind: "ok", text: "fixed" });
    expect(calls).toHaveLength(3);
    expect(calls[2]!.messages.at(-1)!.content).toContain("missing the fixed key");
  });

  it("sends one local call at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    const { deps } = setup({
      transport: {
        complete: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return ok();
        }
      }
    });
    await Promise.all([callModel(deps, t2), callModel(deps, t2), callModel(deps, { ...t2, sourceEventKey: "mail:2" })]);
    expect(peak).toBe(1);
  });

  it("writes no audit row and checks no hosted rule", async () => {
    const { deps, recorded } = setup();
    await callModel(deps, t2);
    expect(recorded).toEqual([]);
    expect(deps.isHostedEligible).not.toHaveBeenCalled();
  });
});

describe("hosted tier", () => {
  it("checks eligibility at the call, sends nothing when refused, and says why", async () => {
    const { deps, calls, recorded } = setup({
      isHostedEligible: vi.fn(async () => ({ eligible: false as const, reason: "sender is labelled sensitive" }))
    });
    const result = await callModel(deps, t3);
    expect(result).toMatchObject({ kind: "refused", reason: "not_eligible" });
    expect(calls).toEqual([]);
    expect(recorded).toEqual([]);
    expect(deps.isHostedEligible).toHaveBeenCalledWith(expect.objectContaining({ sourceEventKey: "mail:1" }));
  });

  it("records exactly one row per send, with the audit fields and no content", async () => {
    const { deps, recorded } = setup({}, [ok('{"a":1}', 123, 45)]);
    await callModel(deps, t3);
    expect(recorded).toEqual([
      { sourceEventKey: "mail:1", tier: "t3", model: "Qwen/Qwen3-14B", tokensIn: 123, tokensOut: 45, reason: "ok" }
    ]);
    expect(JSON.stringify(recorded)).not.toContain("hello");
  });

  it("counts every attempt as a send: a timeout retry and a repair each write a row", async () => {
    const { deps, recorded } = setup({}, [bad("timeout"), bad("bad_output"), ok()]);
    const result = await callModel(deps, t3);
    expect(result.kind).toBe("ok");
    expect(recorded.map((row) => row.reason)).toEqual(["timeout", "bad_output", "ok"]);
    expect(recorded[0]!.tokensIn).toBe(estimateTokens(t3.messages));
    expect(recorded[0]!.tokensOut).toBe(0);
  });

  it("does not warm up a hosted model", async () => {
    const { deps, calls } = setup();
    await callModel(deps, t3);
    expect(calls).toHaveLength(1);
  });

  it("refuses at the message cap, and between retries when the retry would pass it", async () => {
    const full = setup({ usage: vi.fn(async () => ({ messages: 50, tokens: 0 })) });
    expect(await callModel(full.deps, t3)).toMatchObject({ kind: "refused", reason: "message_cap" });
    expect(full.calls).toEqual([]);

    let used = 0;
    const edge = setup(
      {
        usage: vi.fn(async () => ({ messages: used, tokens: 0 })),
        recordCall: vi.fn(async () => {
          used += 1;
        })
      },
      [bad("timeout"), ok()]
    );
    edge.deps.settings.t3DailyMessageCap = 1;
    const result = await callModel(edge.deps, t3);
    expect(result).toMatchObject({ kind: "refused", reason: "message_cap" });
    expect(edge.calls).toHaveLength(1);
  });

  it("refuses when the token cap cannot cover the prompt plus the allowed reply", async () => {
    const { deps, calls } = setup({ usage: vi.fn(async () => ({ messages: 0, tokens: 199_900 })) });
    expect(await callModel(deps, t3)).toMatchObject({ kind: "refused", reason: "token_cap" });
    expect(calls).toEqual([]);
  });

  it("counts the tokens of failed and repaired attempts, and the warm-up, in the result", async () => {
    const { deps } = setup({}, [ok("OK", 10, 5), ok("nope", 100, 20), ok("fixed", 100, 20)]);
    const result = await callModel(deps, { ...t2, validate: (text) => (text === "fixed" ? null : "bad") });
    // warm-up 15 + first attempt 120 + repair 120
    expect(result).toMatchObject({ kind: "ok", tokens: 255 });
  });

  it("a cap that is not a positive number (0, NaN) refuses every send", async () => {
    for (const cap of [0, Number.NaN]) {
      const { deps, calls } = setup();
      deps.settings.t3DailyMessageCap = cap;
      expect(await callModel(deps, t3)).toMatchObject({ kind: "refused", reason: "message_cap" });
      expect(calls).toEqual([]);
    }
  });

  it("a cap of 0 refuses every send and says how to change it", async () => {
    const { deps } = setup();
    deps.settings.t3DailyMessageCap = 0;
    const result = await callModel(deps, t3);
    expect(result).toMatchObject({ kind: "refused", reason: "message_cap" });
    expect((result as { message: string }).message).toContain("Settings > Mail understanding");
  });

  it("refuses the makers the injected descriptor lists, with its sentence, and no others", async () => {
    for (const model of ["widgetco/big-1", "WidgetCo/x"]) {
      const { deps, calls } = setup();
      expect(await callModel(deps, { ...t3, model })).toMatchObject({
        kind: "refused",
        reason: "model_retention",
        message: `ACME REFUSES ${model} (WidgetCo)`
      });
      expect(calls).toEqual([]);
    }
    // Makers that are refused for a different provider are fine here: the list is the descriptor's, not the policy's.
    for (const model of ["google/gemma-3-27b-it", "anthropic/claude-4-opus", "Qwen/Qwen3-14B"]) {
      const { deps, calls } = setup();
      expect(await callModel(deps, { ...t3, model })).toMatchObject({ kind: "ok" });
      expect(calls).toHaveLength(1);
    }
    expect(hostedModelRefusal(FAKE_HOSTED, "zai-org/GLM-5.2")).toBeNull();
  });

  it("words a refusal from the provider's label when the descriptor gives no sentence", () => {
    const { refusalMessage: _sentence, ...plain } = FAKE_HOSTED;
    expect(hostedModelRefusal(plain, "widgetco/x")).toContain("AcmeAI says that company's own");
    const { refusedOrgs: _orgs, ...none } = FAKE_HOSTED;
    expect(hostedModelRefusal(none, "widgetco/x")).toBeNull();
  });

  it("does not send when the audit row cannot be written for a previous send", async () => {
    const { deps } = setup({
      recordCall: vi.fn(async () => {
        throw new Error("db down");
      })
    });
    await expect(callModel(deps, t3)).rejects.toThrow("db down");
  });
});
