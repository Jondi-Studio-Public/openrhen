import { describe, expect, it } from "vitest";
import { MODEL_PROVIDERS } from "@openrhen/contracts";
import { msgClassT0 } from "./msg-class-t0";
import { createHostedChecker } from "./hosted-checker";
import type { Sql } from "@/server/persistence/postgres/sql-pool";

const deps = (over: { messages?: number; tokens?: number; key?: boolean }) => ({
  sql: {} as unknown as Sql,
  userId: "u",
  settings: { t3DailyMessageCap: over.messages ?? 50, t3DailyTokenCap: over.tokens ?? 200_000 },
  keySaved: async () => over.key ?? true,
  input: msgClassT0.input
});
const subject = { sourceEventKey: "k", model: "m" };

describe("the hosted checker's refusals name the exact next call", () => {
  it("a cap of 0 says the PUT and its body", async () => {
    for (const over of [{ messages: 0 }, { tokens: 0 }]) {
      const verdict = await createHostedChecker(deps(over))(subject);
      expect(verdict.eligible).toBe(false);
      if (verdict.eligible) continue;
      expect(verdict.reason).toContain('PUT /api/derived-settings {"t3DailyMessageCap":50,"t3DailyTokenCap":200000}');
    }
  });

  it("no saved key says the PUT to the secret, from the descriptor", async () => {
    const verdict = await createHostedChecker(deps({ key: false }))(subject);
    expect(verdict.eligible).toBe(false);
    if (verdict.eligible) return;
    expect(verdict.reason).toContain(
      `PUT /api/settings/secrets/${MODEL_PROVIDERS.hosted.secretName} {"value":"<the key>"}`
    );
    expect(verdict.reason).toContain(MODEL_PROVIDERS.hosted.label);
  });
});
