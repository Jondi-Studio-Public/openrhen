import { describe, expect, it } from "vitest";
import { DERIVED_SETTINGS_DEFAULTS, DERIVED_SETTINGS_LIMITS, parseDerivedSettingsPatch } from "./derived-settings";

const ok = (body: unknown) => {
  const result = parseDerivedSettingsPatch(body);
  if (!result.ok) throw new Error(result.problems.join(" | "));
  return result.patch;
};
const problems = (body: unknown) => {
  const result = parseDerivedSettingsPatch(body);
  if (result.ok) throw new Error("expected a refusal");
  return result.problems.join(" | ");
};

describe("derived settings defaults", () => {
  it("match the migration's column defaults", () => {
    expect(DERIVED_SETTINGS_DEFAULTS).toEqual({
      ollamaUrl: null,
      t2Model: null,
      t3Model: null,
      t3DailyMessageCap: 50,
      t3DailyTokenCap: 200_000,
      backfillDays: 90
    });
  });
});

describe("ollamaUrl", () => {
  it("accepts an http or https URL and keeps it as typed, minus whitespace and one trailing slash", () => {
    expect(ok({ ollamaUrl: "http://192.168.1.20:11434" })).toEqual({ ollamaUrl: "http://192.168.1.20:11434" });
    expect(ok({ ollamaUrl: "  https://100.64.0.7:11434/ " })).toEqual({ ollamaUrl: "https://100.64.0.7:11434" });
    expect(ok({ ollamaUrl: "http://[fd7a:115c:a1e0::1]:11434" })).toEqual({
      ollamaUrl: "http://[fd7a:115c:a1e0::1]:11434"
    });
  });

  it("clears on null or an empty string", () => {
    expect(ok({ ollamaUrl: null })).toEqual({ ollamaUrl: null });
    expect(ok({ ollamaUrl: "   " })).toEqual({ ollamaUrl: null });
  });

  it("refuses credentials without echoing them", () => {
    const text = problems({ ollamaUrl: "http://alice:hunter2@192.168.1.20:11434" });
    expect(text).toContain("credentials");
    expect(text).not.toContain("hunter2");
    expect(problems({ ollamaUrl: "http://alice@192.168.1.20:11434" })).toContain("credentials");
  });

  it("refuses other schemes, bare hosts, paths, queries and fragments, saying what to send", () => {
    expect(problems({ ollamaUrl: "ftp://192.168.1.20" })).toContain("http:// or https://");
    expect(problems({ ollamaUrl: "192.168.1.20:11434" })).toContain("http:// or https://");
    expect(problems({ ollamaUrl: "file:///etc/passwd" })).toContain("http:// or https://");
    expect(problems({ ollamaUrl: "http://192.168.1.20:11434/api/chat" })).toContain("only the address and port");
    expect(problems({ ollamaUrl: "http://192.168.1.20:11434?x=1" })).toContain("only the address and port");
    expect(problems({ ollamaUrl: "http://192.168.1.20:11434/#top" })).toContain("only the address and port");
    expect(problems({ ollamaUrl: "http://" })).toContain("not a valid address");
    expect(problems({ ollamaUrl: 5 })).toContain("text");
    expect(problems({ ollamaUrl: `http://${"a".repeat(2100)}.example` })).toContain("2048");
  });
});

describe("ollamaUrl is stored as the parsed origin and only when typed exactly so", () => {
  it("refuses a control character or backslash, naming the fix, with no 500-making NUL reaching the database", () => {
    for (const bad of [
      "http://192.168.1.20:11434\u0000",
      "http://192.168.1.20:\u000011434",
      "http://192.168.1.20:11434\n",
      "http://192.168.1.\t20:11434",
      "http://192.168.1.20:11434\r\n",
      "http://192.168.1.20:11434\\",
      "http://192.168.1.20\\@evil:11434",
      "http://192.168.1.20:11434\u007f"
    ]) {
      const text = problems({ ollamaUrl: bad });
      expect(text, JSON.stringify(bad)).toContain("control character or backslash");
      expect(text).toContain("http://192.168.1.20:11434");
    }
  });

  it("refuses a value that is not exactly the origin (plus one optional trailing slash)", () => {
    for (const bad of [
      "http:///192.168.1.20:11434",
      "http://@192.168.1.20:11434",
      "HTTP://192.168.1.20:11434",
      "http://LOCALHOST:11434",
      "http://192.168.1.20:80",
      "https://192.168.1.20:443",
      "http://192.168.1.20:11434//",
      "http:192.168.1.20:11434"
    ]) {
      const result = parseDerivedSettingsPatch({ ollamaUrl: bad });
      expect(result.ok, bad).toBe(false);
    }
    expect(problems({ ollamaUrl: "HTTP://LocalHost:11434" })).toContain('"http://localhost:11434"');
  });

  it("stores the origin", () => {
    expect(ok({ ollamaUrl: "http://192.168.1.20:11434/" })).toEqual({ ollamaUrl: "http://192.168.1.20:11434" });
    expect(ok({ ollamaUrl: "https://host.example" })).toEqual({ ollamaUrl: "https://host.example" });
  });
});

describe("model ids", () => {
  it("accepts ordinary ids, trims, and clears on null or empty", () => {
    expect(ok({ t2Model: " qwen3:8b ", t3Model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" })).toEqual({
      t2Model: "qwen3:8b",
      t3Model: "meta-llama/Llama-3.3-70B-Instruct-Turbo"
    });
    expect(ok({ t2Model: null, t3Model: "" })).toEqual({ t2Model: null, t3Model: null });
  });

  it("refuses path tricks: .. and // in an id", () => {
    for (const bad of ["../qwen", "a/../b", "a//b", "a..b", "meta//llama"]) {
      expect(problems({ t2Model: bad }), bad).toContain("t2Model");
    }
    expect(ok({ t3Model: "meta/llama-3.3-70b.v2" })).toEqual({ t3Model: "meta/llama-3.3-70b.v2" });
  });

  it("refuses spaces, control characters and a long id", () => {
    expect(problems({ t2Model: "qwen 3" })).toContain("t2Model");
    expect(problems({ t3Model: "a\nb" })).toContain("t3Model");
    expect(problems({ t2Model: "x".repeat(201) })).toContain("200");
    expect(problems({ t2Model: 7 })).toContain("text");
  });
});

describe("caps and backfill", () => {
  it("accepts the ends of each range", () => {
    expect(
      ok({
        t3DailyMessageCap: 0,
        t3DailyTokenCap: DERIVED_SETTINGS_LIMITS.t3DailyTokenCap.max,
        backfillDays: 1
      })
    ).toEqual({ t3DailyMessageCap: 0, t3DailyTokenCap: 100_000_000, backfillDays: 1 });
    expect(ok({ t3DailyMessageCap: 10_000, backfillDays: 3650 })).toEqual({
      t3DailyMessageCap: 10_000,
      backfillDays: 3650
    });
  });

  it("names the range and the fix when a number is out of it", () => {
    expect(problems({ t3DailyMessageCap: 10_001 })).toMatch(
      /t3DailyMessageCap.*0 to 10000.*0 to turn hosted sends off/
    );
    expect(problems({ t3DailyMessageCap: -1 })).toContain("0 to 10000");
    expect(problems({ t3DailyTokenCap: 100_000_001 })).toContain("0 to 100000000");
    expect(problems({ backfillDays: 0 })).toMatch(/backfillDays.*1 to 3650/);
    expect(problems({ backfillDays: 3651 })).toContain("1 to 3650");
  });

  it("refuses non-integers, strings and null, because these have defaults and cannot be cleared", () => {
    expect(problems({ backfillDays: 30.5 })).toContain("whole number");
    expect(problems({ backfillDays: "30" })).toContain("whole number");
    expect(problems({ t3DailyTokenCap: null })).toContain("whole number");
    expect(problems({ t3DailyMessageCap: Number.NaN })).toContain("whole number");
  });
});

describe("the body", () => {
  it("must be an object with at least one known field", () => {
    expect(problems(null)).toContain("JSON object");
    expect(problems([])).toContain("JSON object");
    expect(problems({})).toContain("at least one of");
  });

  it("refuses unknown fields by name, listing the known ones, and reports every problem at once", () => {
    const text = problems({ ollamaKey: "x", backfillDays: 0, t3DailyMessageCap: -5 });
    expect(text).toContain("ollamaKey");
    expect(text).toContain("ollamaUrl");
    expect(text).toContain("backfillDays");
    expect(text).toContain("t3DailyMessageCap");
  });

  it("points a hosted key at the passwords and keys page instead of accepting it", () => {
    expect(problems({ deepinfraApiKey: "k" })).toContain("Passwords and keys");
    expect(problems({ apiKey: "k" })).toContain("Passwords and keys");
  });
});
