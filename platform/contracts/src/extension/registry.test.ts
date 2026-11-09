import { describe, expect, it } from "vitest";
import { resetRegistry } from "./testing.js";
import * as publicEntry from "./registry.js";
import { createRegistry } from "./registry.js";

const make = () => createRegistry<string>({ name: "example-things", key: "thing id" });

describe("createRegistry", () => {
  it("keeps what was registered, in registration order, with the owner of each entry", () => {
    const registry = make();
    registry.register({ key: "b", owner: "core", value: "one" });
    registry.register({ key: "a", owner: "example_addon", value: "two" });
    expect(registry.entries()).toEqual([
      { key: "b", owner: "core", value: "one" },
      { key: "a", owner: "example_addon", value: "two" }
    ]);
    expect(registry.name).toBe("example-things");
    expect(registry.key).toBe("thing id");
  });

  it("throws on a duplicate key and names both owners", () => {
    const registry = make();
    registry.register({ key: "dup", owner: "core", value: "first" });
    expect(() => registry.register({ key: "dup", owner: "example_addon", value: "second" })).toThrow(
      /example-things.*"dup".*core.*example_addon/s
    );
    expect(registry.entries()).toEqual([{ key: "dup", owner: "core", value: "first" }]);
  });

  it("throws on a duplicate from the same owner too, instead of being a silent no-op", () => {
    const registry = make();
    registry.register({ key: "dup", owner: "core", value: "first" });
    expect(() => registry.register({ key: "dup", owner: "core", value: "again" })).toThrow(/already registered/);
  });

  it("refuses an empty key or owner", () => {
    const registry = make();
    expect(() => registry.register({ key: "", owner: "core", value: "x" })).toThrow(/key/);
    expect(() => registry.register({ key: "k", owner: "", value: "x" })).toThrow(/owner/);
  });

  it("refuses a registration after freeze() and reports the state", () => {
    const registry = make();
    registry.register({ key: "a", owner: "core", value: "one" });
    expect(registry.frozen).toBe(false);
    registry.freeze();
    registry.freeze(); // idempotent
    expect(registry.frozen).toBe(true);
    expect(() => registry.register({ key: "b", owner: "core", value: "two" })).toThrow(/frozen/);
    expect(registry.entries()).toHaveLength(1);
  });

  it("returns a copy from entries(), so a caller cannot edit the registry through it", () => {
    const registry = make();
    registry.register({ key: "a", owner: "core", value: "one" });
    const snapshot = registry.entries() as unknown as { key: string }[];
    expect(() => snapshot.push({ key: "x" })).toThrow();
    expect(registry.entries()).toHaveLength(1);
  });

  describe("teardown", () => {
    it("removes the entry it registered", () => {
      const registry = make();
      const remove = registry.register({ key: "a", owner: "example_addon", value: "one" });
      remove();
      expect(registry.entries()).toEqual([]);
      registry.register({ key: "a", owner: "example_addon", value: "again" });
      expect(registry.entries()).toHaveLength(1);
    });

    it("never removes another owner's key (P-extension-sdk-12)", () => {
      const registry = make();
      registry.register({ key: "core_thing", owner: "core", value: "core's" });
      const removeAddon = registry.register({ key: "addon_thing", owner: "example_addon", value: "addon's" });
      removeAddon();
      removeAddon(); // a second call is harmless
      expect(registry.entries()).toEqual([{ key: "core_thing", owner: "core", value: "core's" }]);
    });

    it("a stale teardown does not remove a later owner's entry under the same key", () => {
      const registry = make();
      const removeFirst = registry.register({ key: "shared", owner: "first", value: "1" });
      removeFirst();
      registry.register({ key: "shared", owner: "second", value: "2" });
      removeFirst();
      expect(registry.entries()).toEqual([{ key: "shared", owner: "second", value: "2" }]);
    });

    it("a failed duplicate registration leaves the first owner's teardown in charge of its key", () => {
      const registry = make();
      const removeCore = registry.register({ key: "k", owner: "core", value: "core's" });
      expect(() => registry.register({ key: "k", owner: "example_addon", value: "addon's" })).toThrow();
      removeCore();
      expect(registry.entries()).toEqual([]);
    });

    it("refuses to run once the registry is frozen", () => {
      const registry = make();
      const remove = registry.register({ key: "a", owner: "core", value: "one" });
      registry.freeze();
      expect(() => remove()).toThrow(/frozen/);
      expect(registry.entries()).toHaveLength(1);
    });
  });
});

describe("resetRegistry (the /testing subpath)", () => {
  it("empties and unfreezes a registry between tests", () => {
    const registry = make();
    registry.register({ key: "a", owner: "core", value: "one" });
    registry.freeze();
    resetRegistry(registry);
    expect(registry.entries()).toEqual([]);
    expect(registry.frozen).toBe(false);
    registry.register({ key: "a", owner: "core", value: "one" });
  });

  it("is not a method of the registry the production code sees", () => {
    const registry = make();
    expect(Object.keys(registry).sort()).toEqual(["entries", "freeze", "frozen", "key", "name", "register"]);
    expect("reset" in registry).toBe(false);
  });

  it("cannot be reached from the public entry: no exported hook, no symbol on the registry", () => {
    const registry = make();
    expect(Object.keys(publicEntry)).toEqual(["createRegistry"]);
    expect(Object.getOwnPropertySymbols(registry)).toEqual([]);
    expect(Reflect.ownKeys(registry).filter((key) => typeof key === "symbol")).toEqual([]);
    // The old hook was a global symbol any consumer could name.
    const guess = (registry as unknown as Record<symbol, unknown>)[Symbol.for("openrhen.registry.reset")];
    expect(guess).toBeUndefined();
    // Nor through the constructor: no static or prototype member empties or unfreezes it.
    const statics = Object.getOwnPropertyNames(registry.constructor).filter(
      (name) => !["length", "name", "prototype"].includes(name)
    );
    expect(statics).toEqual([]);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(registry))).toEqual(["constructor"]);
    registry.register({ key: "a", owner: "core", value: "one" });
    registry.freeze();
    expect(registry.frozen).toBe(true);
    expect(registry.entries()).toHaveLength(1);
  });

  it("makes an earlier teardown a no-op rather than a removal of the new entry", () => {
    const registry = make();
    const remove = registry.register({ key: "a", owner: "first", value: "1" });
    resetRegistry(registry);
    registry.register({ key: "a", owner: "second", value: "2" });
    remove();
    expect(registry.entries()).toEqual([{ key: "a", owner: "second", value: "2" }]);
  });

  it("refuses an object that is not a registry", () => {
    expect(() => resetRegistry({} as never)).toThrow(/createRegistry/);
  });
});
