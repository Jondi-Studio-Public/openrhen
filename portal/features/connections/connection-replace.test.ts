import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { deriveConnectionSummaries, PROVIDER_ROWS } from "./connection-summaries";
import { registerConnectionExtension } from "./connection-extensions";
import type { ConnectionInputs } from "./use-connection-data";

vi.mock("@/state/private/index", () => ({}));

const inputs = {
  ready: true,
  timezone: "UTC",
  planning: { status: "current", lastSuccessfulAt: "2026-11-03T21:33:00.000Z" },
  probe: { state: "reachable", latencyMs: 3, status: "ok", contractVersion: "1", engineVersion: "1" },
  providers: {},
  googleProof: { status: "not_configured" },
  googleSync: { state: "off" },
  extensions: {}
} as unknown as ConnectionInputs;

describe("a connection extension that replaces a core row", () => {
  it("takes the core row's place, so the page names no vendor the extension supplies itself", () => {
    const replaced = PROVIDER_ROWS[0]!.id;
    registerConnectionExtension({
      id: replaced,
      title: "Supplied by an extension",
      after: "planner",
      replaces: replaced,
      useRead: () => undefined,
      summary: () => ({ id: replaced, title: "Supplied by an extension", state: "on", meta: "Answering" }),
      Detail: () => createElement("div")
    });
    const rows = deriveConnectionSummaries(inputs, new Date("2026-11-04T00:00:00Z"));
    expect(rows.filter((row) => row.id === replaced)).toHaveLength(1);
    expect(rows.find((row) => row.id === replaced)?.title).toBe("Supplied by an extension");
    expect(rows.map((row) => row.id)).toEqual(["planner", replaced, "google-calendar", PROVIDER_ROWS[1]!.id]);
  });
});
