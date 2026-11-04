import { describe, expect, it } from "vitest";
import {
  changeLogActor,
  changeLogConfirmedBy,
  parseAgentHeader,
  parseClaimHeaders,
  requestAgent,
  requestClaim,
  requestDirectWrites,
  requestScopes,
  runWithActor
} from "./agent-actor";

describe("parseAgentHeader", () => {
  it("treats an absent or blank header as a person", () => {
    expect(parseAgentHeader(null)).toBeUndefined();
    expect(parseAgentHeader("  ")).toBeUndefined();
  });
  it("lower-cases a valid name", () => {
    expect(parseAgentHeader(" Claude-Code_1 ")).toBe("claude-code_1");
  });
  it("refuses bad or reserved names", () => {
    for (const value of ["has space", "x".repeat(33), "system", "Human", "a/b"])
      expect(parseAgentHeader(value)).toBe("invalid");
  });
});

describe("request actor", () => {
  it("is system with no request, null for a person, the name for an agent", () => {
    expect(changeLogActor()).toBe("system");
    expect(requestAgent()).toBeNull();
    runWithActor(null, () => {
      expect(changeLogActor()).toBeNull();
      expect(requestAgent()).toBeNull();
    });
    runWithActor("scribe", () => {
      expect(changeLogActor()).toBe("scribe");
      expect(requestAgent()).toBe("scribe");
    });
  });
});

describe("confirmedBy", () => {
  it("is set only for a write the owner confirmed on an agent's behalf", () => {
    expect(changeLogConfirmedBy()).toBeUndefined();
    runWithActor("scribe", () => expect(changeLogConfirmedBy()).toBeUndefined());
    runWithActor(
      "scribe",
      () => {
        expect(changeLogActor()).toBe("scribe");
        expect(changeLogConfirmedBy()).toBe("owner");
      },
      "owner"
    );
  });
});

describe("parseClaimHeaders", () => {
  it("is empty when neither header is sent", () => {
    expect(parseClaimHeaders(new Headers())).toEqual({ ok: true, claim: {} });
  });
  it("reads the basis and the percent-encoded evidence", () => {
    const headers = new Headers({
      "x-openrhen-basis": "Stated",
      "x-openrhen-evidence": encodeURIComponent("Friday’s fine 🙂")
    });
    expect(parseClaimHeaders(headers)).toEqual({ ok: true, claim: { basis: "stated", evidence: "Friday’s fine 🙂" } });
  });
  it("refuses a bad basis, long evidence, control characters and bad encoding, without echoing the value", () => {
    const bad = [
      { "x-openrhen-basis": "guess-secret" },
      { "x-openrhen-evidence": "x".repeat(301) },
      { "x-openrhen-evidence": encodeURIComponent("a\nb") },
      { "x-openrhen-evidence": "%E0%A4%A" }
    ];
    for (const init of bad) {
      const result = parseClaimHeaders(new Headers(init));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).not.toMatch(/secret|xxxx/);
    }
  });
});

describe("request claim", () => {
  it("is held for an agent only", () => {
    expect(requestClaim()).toBeUndefined();
    runWithActor("scribe", () => expect(requestClaim()).toEqual({ basis: "stated", evidence: "yes" }), undefined, {
      basis: "stated",
      evidence: "yes"
    });
    runWithActor(null, () => expect(requestClaim()).toBeUndefined(), undefined, { basis: "stated" });
    runWithActor("scribe", () => expect(requestClaim()).toBeUndefined());
  });
});

describe("request scopes", () => {
  it("are held for a database-token agent only", () => {
    expect(requestScopes()).toBeUndefined();
    runWithActor("scribe", () => expect(requestScopes()).toEqual(["write:catch-up"]), undefined, undefined, [
      "write:catch-up"
    ]);
    runWithActor(null, () => expect(requestScopes()).toBeUndefined(), undefined, undefined, ["write:catch-up"]);
    runWithActor("scribe", () => expect(requestScopes()).toBeUndefined());
  });
});

describe("request direct writes", () => {
  it("are held for a database-token agent only", () => {
    expect(requestDirectWrites()).toBeUndefined();
    runWithActor("scribe", () => expect(requestDirectWrites()).toEqual({ action: "on" }), undefined, undefined, [], {
      action: "on"
    });
    runWithActor(null, () => expect(requestDirectWrites()).toBeUndefined(), undefined, undefined, [], {
      action: "on"
    });
    runWithActor("scribe", () => expect(requestDirectWrites()).toBeUndefined());
  });
});
