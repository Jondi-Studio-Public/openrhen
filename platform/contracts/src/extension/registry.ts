import { RegistryCore } from "./registry-internal.js";

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

export function createRegistry<V>(options: RegistryOptions): Registry<V> {
  return new RegistryCore<V>(options);
}
