import { describe, expect, it } from "vitest";
import { calendarSinkLabel, registerConnectionManifest } from "./connections/registry.js";
import { contractsExtensions, registerContractsExtension } from "./extensions.js";
import { enterCoreOnly, withoutContractsExtensions } from "./core-only.js";
import { dataFlowRegistry } from "./data-flow/data-flow.js";
import { BUILTIN_CONNECTIONS } from "./connections/builtin-connections.js";
import { connectionRegistry } from "./connections/registry.js";

describe("withoutContractsExtensions", () => {
  it("hides registered extensions while it runs and restores them after, even on a throw", () => {
    registerContractsExtension({ id: "core-only-test" });
    expect(contractsExtensions().map((e) => e.id)).toContain("core-only-test");
    expect(withoutContractsExtensions(() => contractsExtensions().length)).toBe(0);
    expect(() =>
      withoutContractsExtensions(() => {
        throw new Error("boom");
      })
    ).toThrow("boom");
    expect(contractsExtensions().map((e) => e.id)).toContain("core-only-test");
  });

  it("also cuts the connection registry back to the built-in manifests", () => {
    const before = connectionRegistry().length;
    const builtIn = BUILTIN_CONNECTIONS.length;
    const label = withoutContractsExtensions(() => calendarSinkLabel());
    registerConnectionManifest({
      id: "core-only-sink",
      label: "Sink",
      capabilities: ["calendar_sink"]
    } as unknown as Parameters<typeof registerConnectionManifest>[0]);
    expect(connectionRegistry()).toHaveLength(before + 1);
    expect(withoutContractsExtensions(() => [connectionRegistry().length, calendarSinkLabel()])).toEqual([
      builtIn,
      label
    ]);
    expect(connectionRegistry()).toHaveLength(before + 1);
  });
});

describe("enterCoreOnly", () => {
  it("cuts the registry back until the returned function runs, and drops a fixture registered meanwhile", () => {
    registerContractsExtension({
      id: "core-only-held",
      dataFlow: () => ({ amend: { "no-such-entry": { device: "x" } } })
    });
    const leave = enterCoreOnly();
    expect(contractsExtensions()).toHaveLength(0);
    expect(dataFlowRegistry().extensionIds).toEqual([]);
    registerContractsExtension({ id: "core-only-fixture" });
    expect(contractsExtensions().map((e) => e.id)).toEqual(["core-only-fixture"]);
    leave();
    const ids = contractsExtensions().map((e) => e.id);
    expect(ids).toContain("core-only-held");
    expect(ids).not.toContain("core-only-fixture");
    expect(dataFlowRegistry().extensionIds).toContain("core-only-held");
  });
});
