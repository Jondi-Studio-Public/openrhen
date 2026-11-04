import { describe, expect, it } from "vitest";
import {
  OWNER_ONLY_SETTINGS_FIELDS,
  PLAN_PREFERENCE_SETTINGS_FIELDS,
  PROPOSE_ONLY_SETTINGS_FIELDS,
  WAKE_SETTINGS_FIELDS
} from "./agent-scopes.js";
import { agentPolicyLines, agentPolicySentences } from "./agent-policy-text.js";

describe("agent policy text", () => {
  const settings = agentPolicyLines().find((line) => line.id === "settings")!;

  it("lists every settings field from the scope constants, so a new field cannot be left out", () => {
    for (const field of [
      ...PLAN_PREFERENCE_SETTINGS_FIELDS,
      ...PROPOSE_ONLY_SETTINGS_FIELDS,
      ...OWNER_ONLY_SETTINGS_FIELDS,
      ...WAKE_SETTINGS_FIELDS
    ])
      expect(settings.full).toContain(field);
  });

  it("keeps each sentence on one line and names the owner as asked", () => {
    for (const detail of ["full", "brief"] as const)
      for (const sentence of agentPolicySentences("Alex", detail)) {
        expect(sentence).not.toContain("\n");
        expect(sentence).not.toContain("the person's");
      }
    expect(agentPolicySentences("Alex", "full").join(" ")).toContain("Alex's to confirm");
  });

  it("states the agreed rules", () => {
    const text = agentPolicySentences().join("\n");
    expect(text).toContain("apply directly when its token has direct writes on");
    expect(text).toContain("You may confirm Inbox items");
    expect(text).toContain("You never approve or reject a proposal");
    expect(text).toContain("Never send mail");
    expect(text).toContain("create: true");
    expect(text).toContain("When a refusal names a command, run it; otherwise tell the person what it says.");
    expect(text).not.toContain("another way");
    expect(text).toContain("structuredContent.error with code");
  });
});
