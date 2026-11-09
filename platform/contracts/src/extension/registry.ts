/**
 * The one way core holds a collection that add-ons fill. A registry knows its name and what its key is, refuses a
 * duplicate key (naming both owners), can be frozen once boot has finished, and hands out a teardown that removes only
 * the entry it registered. There is no `reset` here: tests get one from `@openrhen/contracts/testing`.
 *
 * A registry that is declared with this function carries a `@seam` tag on its declaration; the seam inventory
 * (`scripts/test/seam-inventory.test.mjs`) reads the tag and the `name` and `key` written here.
 */
export interface RegistryOptions {
  /** The registry's name, as the seam list shows it (for example `calendar-diff-profiles`). */
  name: string;
  /** What each key identifies (for example `profile id`). */
  key: string;
}

export interface RegistryEntry<V> {
  key: string;
  owner: string;
  value: V;
}

export interface Registry<V> {
  readonly name: string;
  readonly key: string;
  readonly frozen: boolean;
  /**
   * Adds an entry. Throws if the key is already registered (by anyone, the same owner included) or the registry is
   * frozen. Returns a teardown that removes this entry and nothing else.
   */
  register(entry: RegistryEntry<V>): () => void;
  /** Ends registration. Idempotent. */
  freeze(): void;
  /** A copy of the entries, in registration order. */
  entries(): readonly RegistryEntry<V>[];
}

/** The hook `@openrhen/contracts/testing` uses. Not part of `Registry`, so production code cannot name it by type. */
export const RESET_REGISTRY = Symbol.for("openrhen.registry.reset");

export function createRegistry<V>(options: RegistryOptions): Registry<V> {
  const { name, key: keyLabel } = options;
  // Each registration is its own object, so a teardown compares identity: a stale teardown, or one from another owner,
  // finds a different record under the key (or none) and leaves it alone.
  const records = new Map<string, RegistryEntry<V>>();
  let frozen = false;

  const registry: Registry<V> & { [RESET_REGISTRY]: () => void } = {
    name,
    key: keyLabel,
    get frozen() {
      return frozen;
    },
    register(entry) {
      if (frozen)
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
        if (frozen)
          throw new Error(`Registry "${name}" is frozen: ${record.owner} cannot remove ${keyLabel} "${record.key}".`);
        if (records.get(record.key) === record) records.delete(record.key);
      };
    },
    freeze() {
      frozen = true;
    },
    entries() {
      return Object.freeze([...records.values()].map((record) => ({ ...record })));
    },
    [RESET_REGISTRY]() {
      records.clear();
      frozen = false;
    }
  };
  // The hook is not enumerable, so listing a registry's keys shows only its public surface.
  Object.defineProperty(registry, RESET_REGISTRY, { enumerable: false });
  return registry;
}
