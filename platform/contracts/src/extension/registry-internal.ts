// Module-private to the extension folder. The package exports `./extension` (registry.ts) and `./testing` (testing.ts)
// only, so no consumer can import this file. The registry's state is in ES private fields, so nothing on the object
// (a property, a symbol, `registry.constructor`) reaches it; the one function that can empty it is `resetCore`, and it
// is only imported by testing.ts. This file holds no module-level collection: the seam inventory would list one.
import type { Registry, RegistryEntry, RegistryOptions } from "./registry.js";

function build() {
  let reset: (registry: object) => void = () => {
    throw new Error("resetRegistry needs a registry made by createRegistry.");
  };

  class RegistryCore<V> implements Registry<V> {
    declare readonly frozen: boolean;
    readonly name: string;
    readonly key: string;
    readonly register: Registry<V>["register"];
    readonly freeze: Registry<V>["freeze"];
    readonly entries: Registry<V>["entries"];
    // Each registration is its own record, so a teardown compares identity: a stale teardown, or one from another owner,
    // finds a different record under the key (or none) and leaves it alone.
    readonly #records = new Map<string, RegistryEntry<V>>();
    #frozen = false;

    static {
      reset = (registry) => {
        if (!(#records in registry)) throw new Error("resetRegistry needs a registry made by createRegistry.");
        registry.#records.clear();
        registry.#frozen = false;
      };
    }

    constructor(options: RegistryOptions) {
      const { name, key: keyLabel } = options;
      const records = this.#records;
      this.name = name;
      this.key = keyLabel;
      Object.defineProperty(this, "frozen", { enumerable: true, get: () => this.#frozen });
      this.register = (entry) => {
        if (this.#frozen)
          throw new Error(`Registry "${name}" is frozen: ${entry.owner} cannot register ${keyLabel} "${entry.key}".`);
        if (!entry.key) throw new Error(`Registry "${name}" needs a non-empty ${keyLabel} (key) to register.`);
        if (!entry.owner) throw new Error(`Registry "${name}" needs the owner of ${keyLabel} "${entry.key}".`);
        const existing = records.get(entry.key);
        if (existing) {
          throw new Error(
            `Registry "${name}": ${keyLabel} "${entry.key}" is already registered by ${existing.owner}; ${entry.owner} cannot register it again.`
          );
        }
        const record: RegistryEntry<V> = { key: entry.key, owner: entry.owner, value: entry.value };
        records.set(record.key, record);
        return () => {
          if (this.#frozen)
            throw new Error(`Registry "${name}" is frozen: ${record.owner} cannot remove ${keyLabel} "${record.key}".`);
          if (records.get(record.key) === record) records.delete(record.key);
        };
      };
      this.freeze = () => {
        this.#frozen = true;
      };
      this.entries = () => Object.freeze([...records.values()].map((record) => ({ ...record })));
    }
  }

  return { RegistryCore, reset };
}

const built = build();
export const RegistryCore: new <V>(options: RegistryOptions) => Registry<V> = built.RegistryCore;

/** Empties a registry and unfreezes it. Imported only by testing.ts. */
export const resetCore: (registry: object) => void = built.reset;
