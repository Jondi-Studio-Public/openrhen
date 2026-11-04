import { describe, expect, it } from "vitest";
import { fakeFetch, type RecordedCall } from "../test/fake-fetch.js";
import { createClient } from "./client.js";
import type { CliConfig } from "./config.js";
import { CliError, EXIT } from "./errors.js";

function config(overrides: Partial<CliConfig> = {}): CliConfig {
  return { url: "http://localhost:8787", timeoutMs: 10_000, allowPublic: false, ...overrides };
}

describe("createClient({ readOnly: true }): the second guard behind the command-level check", () => {
  it("refuses a POST before fetchImpl is ever called", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = fakeFetch({ "/api/things": { status: 200, body: { ok: true } } }, calls);
    const client = createClient(config(), { fetchImpl, warn: () => {}, readOnly: true });
    await expect(client.post("/api/things", { name: "widget" })).rejects.toBeInstanceOf(CliError);
    expect(calls).toHaveLength(0);
  });

  it("refuses a PUT and a DELETE the same way", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = fakeFetch({ "/api/things/1": { status: 200, body: { ok: true } } }, calls);
    const client = createClient(config(), { fetchImpl, warn: () => {}, readOnly: true });
    await expect(client.put!("/api/things/1", {})).rejects.toBeInstanceOf(CliError);
    await expect(client.del!("/api/things/1")).rejects.toBeInstanceOf(CliError);
    expect(calls).toHaveLength(0);
  });

  it("the refusal is a usage error naming the method and path", async () => {
    const client = createClient(config(), {
      fetchImpl: fakeFetch({}),
      warn: () => {},
      readOnly: true
    });
    try {
      await client.post("/api/things", {});
      expect.unreachable();
    } catch (error) {
      const failure = error as CliError;
      expect(failure.exitCode).toBe(EXIT.usage);
      expect(failure.message).toContain("POST");
      expect(failure.message).toContain("/api/things");
    }
  });

  it("still allows a GET", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = fakeFetch({ "/api/things": { status: 200, body: { ok: true } } }, calls);
    const client = createClient(config(), { fetchImpl, warn: () => {}, readOnly: true });
    await expect(client.get("/api/things")).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
  });

  it("without readOnly, POST behaves as usual", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = fakeFetch({ "/api/things": { status: 200, body: { ok: true } } }, calls);
    const client = createClient(config(), { fetchImpl, warn: () => {} });
    await expect(client.post("/api/things", { name: "widget" })).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });
});
