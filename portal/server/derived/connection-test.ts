import { callModel, type PolicyDeps, type Tier } from "./call-policy";

/**
 * The settings card's Test button: one small call per tier with fixed synthetic text. It never reads mail, so the
 * hosted-eligibility rule has nothing to judge and is not asked; a hosted test is still a send, so it obeys the daily
 * caps and writes its audit row (event key `test:synthetic`).
 */
export const SYNTHETIC_TEST_TEXT =
  "This is synthetic test text, not mail. Subject: Lunch on Friday. Body: Shall we meet at noon on Friday at the cafe by the station?";

export type ConnectionTestResult =
  | { ok: true; tier: Tier; model: string; ms: number; tokensIn: number | null; tokensOut: number | null }
  | { ok: false; tier: Tier; outcome: string; message: string; ms: number };

const readsAsJson = (text: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? null : "it was not a JSON object";
  } catch {
    return "it was not JSON";
  }
};

export async function runConnectionTest(
  policy: PolicyDeps,
  tier: Tier,
  model: string | null,
  now: () => number = Date.now
): Promise<ConnectionTestResult> {
  const started = now();
  if (!model)
    return {
      ok: false,
      tier,
      outcome: "no_model",
      message: `Choose the ${tier === "t2" ? "local" : "hosted"} model first and save, then test.`,
      ms: 0
    };
  const result = await callModel(
    { ...policy, isHostedEligible: async () => ({ eligible: true }) },
    {
      tier,
      sourceEventKey: "test:synthetic",
      model,
      messages: [
        {
          role: "system",
          content: 'Reply with only a JSON object of the form {"ok":true,"topic":"<three words>"} describing the text.'
        },
        { role: "user", content: SYNTHETIC_TEST_TEXT }
      ],
      maxTokens: 64,
      format: "json",
      validate: readsAsJson
    }
  );
  const ms = now() - started;
  if (result.kind === "ok")
    return { ok: true, tier, model: result.model || model, ms, tokensIn: result.tokensIn, tokensOut: result.tokensOut };
  if (result.kind === "refused") return { ok: false, tier, outcome: result.reason, message: result.message, ms };
  return { ok: false, tier, outcome: result.outcome, message: result.message, ms };
}
