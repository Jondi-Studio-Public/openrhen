import type { CalendarDiffProfile } from "./calendar-diff";

/**
 * The diff profiles by the name a manifest declares (`calendarSource.diffProfile`). `calendar` is the one name core
 * registers itself; every other profile registers from its own file, listed in `./calendar-profiles/private/index.ts`,
 * so the OpenRhen export can leave a profile out without core naming it. A leaf module (it imports only a type), so a
 * profile file can register without importing the diff, which imports the seam that lists the profile files.
 */

/** Builds the profile for one connection: the provider id is the stored link prefix, the label words the evidence. */
export type DiffProfileFactory = (provider: string, label: string) => CalendarDiffProfile;

/** What the connection routes need to know of a profile besides its diff, so route code names no profile. */
export interface DiffProfileTraits {
  /** The profile has no generic sync or proof body: the connection's provider supplies both, or the connection is unsupported. */
  ownSync?: boolean;
  /** The sync history also reports the last good run and the oldest run kept, which a failed run since then does not change. */
  reportsLastGoodRun?: boolean;
}

/** The one profile name core owns; an extension may not take it over. */
export const CORE_DIFF_PROFILE = "calendar";

const registered = new Map<string, { factory: DiffProfileFactory; traits: DiffProfileTraits }>();

/**
 * Registers a diff profile under the name a manifest declares. Registering the same factory again is a no-op, so a
 * module imported twice is harmless; a different factory under a name already taken throws, `calendar` included.
 */
export function registerDiffProfile(name: string, factory: DiffProfileFactory, traits: DiffProfileTraits = {}): void {
  if (!name) throw new Error("A diff profile needs a name.");
  const existing = registered.get(name);
  if (existing) {
    if (existing.factory === factory) return;
    throw new Error(`The "${name}" diff profile is already registered.`);
  }
  registered.set(name, { factory, traits });
}

/** The profile registered under `name`, built for one connection, or none. */
export function registeredDiffProfile(name: string, provider: string, label: string): CalendarDiffProfile | undefined {
  return registered.get(name)?.factory(provider, label);
}

export function isDiffProfileRegistered(name: string): boolean {
  return registered.has(name);
}

/** The route-facing traits of a profile; none for a name nothing registered. */
export function diffProfileTraits(name: string): DiffProfileTraits {
  return registered.get(name)?.traits ?? {};
}

/** The names registered so far, for tests and error messages. */
export function registeredDiffProfileNames(): string[] {
  return [...registered.keys()].sort();
}
