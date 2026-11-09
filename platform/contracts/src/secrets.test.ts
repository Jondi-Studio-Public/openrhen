import { describe, expect, it } from "vitest";
import {
  SECRET_LABELS,
  SECRET_NAMES,
  putSecretSchema,
  secretNameSchema,
  secretStatusResponseSchema,
  secretsRefusalMessage
} from "./secrets.js";

describe("secret names", () => {
  it("allows only the names listed in code", () => {
    expect(SECRET_NAMES).toEqual(["youtube_data_api_key", "hosted_model_api_key"]);
    expect(secretNameSchema.safeParse("hosted_model_api_key").success).toBe(true);
    expect(secretNameSchema.safeParse("youtube_data_api_key").success).toBe(true);
    for (const name of ["", "openai_api_key", "YOUTUBE_DATA_API_KEY", "../x", "youtube_data_api_key "])
      expect(secretNameSchema.safeParse(name).success, name).toBe(false);
  });
});

describe("hosted model key label", () => {
  it("is provider-neutral, says it ignores an environment variable, and that a restore empties it", () => {
    const { label, help } = SECRET_LABELS.hosted_model_api_key;
    expect(`${label} ${help}`).not.toMatch(/deepinfra|ollama/i);
    expect(help).toContain("restore");
    expect(help).toContain("ignores any provider key set as an environment variable");
  });
});

describe("put body", () => {
  it("takes one trimmed non-empty value of sane length and nothing else", () => {
    expect(putSecretSchema.parse({ value: "  fakeyt-abc  " })).toEqual({ value: "fakeyt-abc" });
    expect(putSecretSchema.safeParse({ value: "" }).success).toBe(false);
    expect(putSecretSchema.safeParse({ value: "   " }).success).toBe(false);
    expect(putSecretSchema.safeParse({ value: "x".repeat(2049) }).success).toBe(false);
    expect(putSecretSchema.safeParse({ value: "a", extra: 1 }).success).toBe(false);
  });
});

describe("status response", () => {
  it("carries names, state and dates, never a value", () => {
    const parsed = secretStatusResponseSchema.parse({
      masterKeyConfigured: true,
      ownerAuthRequired: false,
      canWrite: false,
      secrets: [{ name: "youtube_data_api_key", isSet: true, updatedAt: "2026-11-06T00:00:00.000Z", state: "set" }]
    });
    expect(Object.keys(parsed.secrets[0]!).sort()).toEqual(["isSet", "name", "state", "updatedAt"]);
  });
});

describe("refusal message", () => {
  it("says exactly what to set and how, for each missing precondition", () => {
    const both = secretsRefusalMessage({ masterKeyConfigured: false, ownerAuthRequired: false });
    expect(both).toContain("OPENRHEN_SECRETS_KEY");
    expect(both).toContain("OPENRHEN_OWNER_AUTH=require");
    expect(both).toMatch(/openssl rand -base64 32|randomBytes/);
    expect(both).toContain("node scripts/setup/init-env.mjs --lockdown");
    expect(secretsRefusalMessage({ masterKeyConfigured: true, ownerAuthRequired: false })).not.toContain(
      "OPENRHEN_SECRETS_KEY"
    );
    expect(secretsRefusalMessage({ masterKeyConfigured: false, ownerAuthRequired: true })).not.toContain(
      "OPENRHEN_OWNER_AUTH=require"
    );
  });
});
