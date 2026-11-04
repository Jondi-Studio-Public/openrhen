import { CAPABILITY_OPS, capabilityFailureSchema, connectionRegistry, type CapabilityId } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { bundledConnections } from "./bundled-connections.js";
import type { OpCall } from "./connection-api.js";

describe("bundled connections conform to their manifests", () => {
  it("binds every registered manifest exactly once, and nothing else", () => {
    const bound = bundledConnections().map(({ manifest }) => manifest.id);
    expect(new Set(bound).size, "a connection is bound twice").toBe(bound.length);
    expect([...bound].sort()).toEqual(
      connectionRegistry()
        .map((manifest) => manifest.id)
        .sort()
    );
  });

  for (const bound of bundledConnections()) {
    const { manifest } = bound;

    it(`${manifest.id} implements exactly the declared capabilities and ops`, () => {
      const impl = bound.create({});
      expect(Object.keys(impl).sort()).toEqual([...manifest.capabilities].sort());
      for (const capability of manifest.capabilities) {
        const declared: readonly string[] = manifest.ops?.[capability] ?? CAPABILITY_OPS[capability];
        expect(Object.keys(impl[capability] ?? {}).sort()).toEqual([...declared].sort());
      }
    });

    it(`${manifest.id} answers every op with an empty body, no env and a failing fetch without throwing`, async () => {
      const impl = bound.create({});
      for (const capability of Object.keys(impl) as CapabilityId[]) {
        for (const [opId, op] of Object.entries(impl[capability] ?? {})) {
          const call: OpCall = {
            body: {},
            fetch: (() => Promise.reject(new Error("network down"))) as typeof fetch,
            signal: new AbortController().signal,
            env: {},
            pathname: `/capabilities/${capability}/${manifest.id}/${opId}`
          };
          const result = await op!.run(call);
          if (result instanceof Response) continue;
          if (result.status >= 400)
            expect(capabilityFailureSchema.safeParse(result.body).success, `${capability}.${opId}`).toBe(true);
        }
      }
    });
  }
});
