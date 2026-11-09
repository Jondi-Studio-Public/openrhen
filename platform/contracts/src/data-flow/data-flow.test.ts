import { describe, expect, it } from "vitest";
import { registerContractsExtension } from "../extensions.js";
import { withoutContractsExtensions } from "../core-only.js";
import type { FlowEntry } from "./types.js";
import { CORE_FLOW_ENTRIES, dataFlowGraph, dataFlowRegistry, PLAN_INPUT_TABLES } from "./data-flow.js";

const TABLES = [
  "activity_events",
  "activity_imports",
  "watch_events",
  "watch_imports",
  "planning_runs",
  ...PLAN_INPUT_TABLES
];

describe("the core registry", () => {
  it("stamps core entries and has no extension in a core-only build", () => {
    const registry = withoutContractsExtensions(() => dataFlowRegistry());
    expect(registry.entries.map((entry) => entry.owner)).toEqual(CORE_FLOW_ENTRIES.map(() => "core"));
    expect(registry.composedBuild).toBe(false);
    expect(registry.extensionIds).toEqual([]);
  });

  it("feeds the engine from the plan-input list minus what it does not read", () => {
    const engine = CORE_FLOW_ENTRIES.find((entry) => entry.to.includes("surface:engine"))!;
    const notRead = (engine.notRead ?? []).map((item) => item.table);
    expect(notRead.length).toBeGreaterThan(0);
    expect(engine.from.map((ref) => ref.slice(3)).sort()).toEqual(
      PLAN_INPUT_TABLES.filter((t) => !notRead.includes(t)).sort()
    );
  });

  it("computes the seed sources' reach: watch history reaches Review, the Health summary is accepted but sends nothing", () => {
    const graph = withoutContractsExtensions(() => dataFlowGraph(TABLES));
    expect(graph.reachLabel("youtube-watch-history")).toBe("Review: watch time by day and hour");
    expect(graph.reachLabel("iphone-health")).toBe("accepted, nothing sends");
    expect(graph.writes("iphone-health")).toEqual(["pg:activity_events[source=iphone-health]"]);
    expect(graph.devices().map((device) => device.id)).toEqual(["pc", "phone", "wearable"]);
    expect(graph.devices().find((device) => device.id === "phone")?.entries).toContain("iphone-health");
  });
});

describe("the extension seam", () => {
  it("adds an extension's entries, stamps their owner and applies amend to core entries", () => {
    registerContractsExtension({
      id: "data-flow-fixture",
      dataFlow: () => ({
        entries: [
          {
            id: "fixture-feed",
            name: "Fixture feed",
            role: "source",
            category: "manual",
            method: "manual",
            trigger: { kind: "none" },
            code: {},
            from: [],
            to: ["pg:watch_events"],
            health: { kind: "none", reason: "fixture" }
          }
        ],
        amend: {
          "iphone-health": { device: "tablet", external: ["fixture-app:Sources/Health.swift"] },
          "no-such-entry": { device: "x" }
        },
        composedBuild: true
      })
    });
    const registry = dataFlowRegistry();
    expect(registry.composedBuild).toBe(true);
    // A composed build registers extensions of its own, so the fixture must be among them, not alone.
    expect(registry.extensionIds).toContain("data-flow-fixture");
    expect(registry.amendKeys).toContain("no-such-entry");
    expect(registry.entries.find((entry) => entry.id === "fixture-feed")?.owner).toBe("data-flow-fixture");
    const amended = registry.entries.find((entry) => entry.id === "iphone-health")!;
    expect(amended.device).toBe("tablet");
    expect(amended.code.external).toEqual(["fixture-app:Sources/Health.swift"]);
    expect(CORE_FLOW_ENTRIES.find((entry) => entry.id === "iphone-health")!.device).toBe("phone");
    expect(
      dataFlowGraph(TABLES)
        .reach("fixture-feed")
        .map((r) => r.surface)
    ).toContain("surface:page/review");
  });
});

describe("core push entries", () => {
  const tokenJudged = (entries: readonly FlowEntry[]) => entries.filter((entry) => entry.health.kind === "last-used");

  it("each judges a bound agent token, falling back to its rows until a tokenName is set", () => {
    const found = tokenJudged(withoutContractsExtensions(() => dataFlowRegistry()).entries);
    expect(found.length).toBeGreaterThanOrEqual(5);
    for (const entry of found) {
      expect(entry.health, entry.id).toEqual({ kind: "last-used", table: "agent_tokens" });
      expect(entry.activitySource, entry.id).toBeDefined();
    }
  });

  it("takes an overlay amend's tokenName into the probe", () => {
    const target = tokenJudged(withoutContractsExtensions(() => dataFlowRegistry()).entries)[0]!;
    registerContractsExtension({
      id: "token-fixture",
      dataFlow: () => ({ amend: { [target.id]: { tokenName: "bound-token" } } })
    });
    const entry = dataFlowRegistry().entries.find((candidate) => candidate.id === target.id)!;
    expect(entry.health).toEqual({ kind: "last-used", table: "agent_tokens", tokenName: "bound-token" });
  });
});
