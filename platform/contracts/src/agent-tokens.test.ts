import { describe, expect, it } from "vitest";
import {
  AGENT_SCOPE_PRESETS,
  allDirectWritesOn,
  DIRECT_WRITE_CLASSES,
  createAgentTokenSchema,
  directWriteMode,
  resolveScopeList
} from "./agent-tokens.js";
import { validateGrantableScopes } from "./agent-scopes.js";

describe("agent token contracts", () => {
  it("makes every preset a list of grantable scopes", () => {
    for (const [name, scopes] of Object.entries(AGENT_SCOPE_PRESETS))
      expect(validateGrantableScopes(scopes), name).toEqual({ scopes: [...scopes], errors: [] });
  });

  it("only lets directWrites promote classes that can write as facts", () => {
    expect(DIRECT_WRITE_CLASSES).not.toContain("settings");
    expect(DIRECT_WRITE_CLASSES).not.toContain("capture");
    expect(DIRECT_WRITE_CLASSES).toContain("commitment");
  });

  it("defaults to 90 days and no direct writes, and normalises the name", () => {
    expect(createAgentTokenSchema.parse({ name: " Companion ", scopes: ["read:plan", "read:plan"] })).toEqual({
      name: "companion",
      scopes: ["read:plan"],
      directWrites: {},
      expiresInDays: 90
    });
  });

  it("rejects admin scopes, unknown classes and modes, and reserved names", () => {
    for (const bad of [
      { name: "a", scopes: ["admin:switches"] },
      { name: "a", scopes: ["read:plan"], directWrites: { settings: "on" } },
      { name: "a", scopes: ["read:plan"], directWrites: { action: "maybe" } },
      { name: "human", scopes: ["read:plan"] },
      { name: "a", scopes: ["read:plan"], expiresInDays: 0 },
      { name: "a", scopes: ["read:plan"], expiresInDays: 400 }
    ])
      expect(createAgentTokenSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("treats an unset class as off", () => {
    expect(directWriteMode({ action: "on" }, "action")).toBe("on");
    expect(directWriteMode({ action: "on" }, "project")).toBe("off");
    expect(directWriteMode(undefined, "action")).toBe("off");
  });

  it("applies settings directly only for a token with every class on", () => {
    expect(directWriteMode(allDirectWritesOn(), "settings")).toBe("on");
    expect(directWriteMode({ ...allDirectWritesOn(), action: "shadow" }, "settings")).toBe("off");
    expect(directWriteMode({ action: "on" }, "settings")).toBe("off");
  });

  it("resolves a preset name or a comma list", () => {
    expect(resolveScopeList("read-only")).toEqual({ ok: true, scopes: [...AGENT_SCOPE_PRESETS["read-only"]!] });
    expect(resolveScopeList("read:plan, propose:capture")).toEqual({
      ok: true,
      scopes: ["read:plan", "propose:capture"]
    });
    expect(resolveScopeList("read:nope")).toMatchObject({ ok: false });
    expect(resolveScopeList(" ")).toMatchObject({ ok: false });
  });
});

describe("the agent-time preset", () => {
  it("grants only the scope that posts session records", () => {
    expect(resolveScopeList("agent-time")).toEqual({ ok: true, scopes: ["write:agent-session"] });
  });
});

describe("the assistant preset", () => {
  it("holds the scopes every write result's follow-up hints name: undo, recalculate and inbox", () => {
    const scopes = resolveScopeList("assistant");
    expect(scopes.ok).toBe(true);
    if (scopes.ok)
      expect(scopes.scopes).toEqual(
        expect.arrayContaining([
          "write:undo",
          "write:recalculate",
          "write:inbox",
          "write:disruption",
          "write:deliverable"
        ])
      );
  });
});
