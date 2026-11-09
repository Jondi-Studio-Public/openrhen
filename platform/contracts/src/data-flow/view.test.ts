import { describe, expect, it } from "vitest";
import { buildDataFlowView, registryTables } from "./view.js";
import type { FlowEntry } from "./types.js";

const e = (id: string, extra: Partial<FlowEntry>): FlowEntry => ({
  id,
  name: id,
  role: "source",
  category: "manual",
  method: "manual",
  trigger: { kind: "none" },
  code: {},
  from: [],
  to: [],
  health: { kind: "none", reason: "fixture" },
  ...extra
});

describe("buildDataFlowView", () => {
  const registry = {
    entries: [
      e("writer", { to: ["pg:notes", "pg:lonely"] }),
      e("reader", { role: "reader", from: ["pg:notes"], to: ["surface:page/review"], gives: "notes" })
    ],
    datasets: [],
    composedBuild: false
  };
  it("lists tables the entries name", () => expect(registryTables(registry)).toEqual(["lonely", "notes"]));
  it("gives each entry its reach, edges for reads and writes, and what is unused", () => {
    const view = buildDataFlowView(registryTables(registry), registry);
    expect(view.build).toBe("merged");
    expect(view.entries.find((x) => x.id === "writer")?.reach).toBe("Review: notes");
    expect(view.edges).toContainEqual({ from: "writer", to: "pg:notes", kind: "writes" });
    expect(view.edges).toContainEqual({ from: "pg:notes", to: "reader", kind: "reads" });
    expect(view.unused.datasets).toEqual(["pg:lonely"]);
  });
  it("calls a composed build pinned", () => {
    expect(buildDataFlowView([], { ...registry, composedBuild: true }).build).toBe("pinned");
  });
});
