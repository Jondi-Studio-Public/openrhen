import { describe, expect, it } from "vitest";
import { calendarSinkLabel, registerConnectionManifest } from "./connections/registry.js";
import { contractsExtensions, registerContractsExtension } from "./extensions.js";
import { withoutContractsExtensions } from "./core-only.js";
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
