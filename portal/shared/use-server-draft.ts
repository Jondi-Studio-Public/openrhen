"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

/**
 * A local draft that reseeds from a server value, but only while nothing has touched it since the
 * last seed.
 *
 * Settings pages hold a local draft next to the server's own copy so a form can be edited before it
 * is saved. The server copy is rebuilt on every state reload — `normalizePortalState` constructs a
 * new object each time — and those reloads land constantly and without warning: a validity-boundary
 * run finishing, another tab's edit, the post-command plan-refresh poll. A plain `useEffect(() => {
 * if (ready) setDraft(serverValue) }, [ready, serverValue])` reseeds on every one of them, snapping a
 * half-typed value back to whatever the server last held.
 *
 * This hook tracks dirtiness instead: `setDraft` marks the draft dirty, and reseeding is skipped
 * while dirty. A caller marks the draft pristine again once its own edit is settled — ordinarily
 * after a successful save, since the draft it just sent is (or is about to become) the server's own
 * value, and the next reload should be free to resync it. `resetDraft` does both at once, for a
 * caller that replaces the draft programmatically (a form clearing itself, a cancel button) rather
 * than through user input.
 *
 * `version` is a second, separate piece of server truth this hook tracks alongside the draft: the
 * optimistic-concurrency version the draft was last known to agree with. `seededVersion` holds that
 * version at the moment the draft was seeded (or last marked pristine), and — like the draft itself —
 * stops moving the instant the draft goes dirty. A caller that sends `expectedVersion: seededVersion`
 * instead of the live, ever-moving server version is protected against the lost-update bug where two
 * edits started from the same version, one saves, and the second silently overwrites it: the second
 * save's `expectedVersion` still names the version it was actually composed against, so the server's
 * own conflict check catches it.
 */
export function useServerDraft<T>(
  serverValue: T,
  ready: boolean,
  version: number | null = null
): {
  draft: T;
  setDraft: Dispatch<SetStateAction<T>>;
  resetDraft: (value: T, nextVersion?: number | null) => void;
  markPristine: () => void;
  seededVersion: number | null;
  /** The server value the draft was seeded from, so a save can tell which fields the user changed. */
  seededValue: T;
} {
  const [draft, setDraftState] = useState(serverValue);
  const [seededVersion, setSeededVersion] = useState(version);
  const [seededValue, setSeededValue] = useState(serverValue);
  const dirty = useRef(false);
  // Kept fresh on every render (not just when a reseed fires) so `markPristine` — called from an
  // event handler, possibly before this component has re-rendered with the newest server value —
  // still reads the most recent version this hook has seen.
  const versionRef = useRef(version);
  const valueRef = useRef(serverValue);
  useLayoutEffect(() => {
    versionRef.current = version;
    valueRef.current = serverValue;
  });

  useEffect(() => {
    if (!ready || dirty.current) return;
    setDraftState(serverValue);
    setSeededVersion(version);
    setSeededValue(serverValue);
  }, [ready, serverValue, version]);

  const setDraft = useCallback<Dispatch<SetStateAction<T>>>((update) => {
    dirty.current = true;
    setDraftState(update);
  }, []);

  const resetDraft = useCallback((value: T, nextVersion?: number | null) => {
    dirty.current = false;
    setDraftState(value);
    setSeededVersion(nextVersion !== undefined ? nextVersion : versionRef.current);
    setSeededValue(value);
  }, []);

  const markPristine = useCallback(() => {
    dirty.current = false;
    setSeededVersion(versionRef.current);
    setSeededValue(valueRef.current);
  }, []);

  return { draft, setDraft, resetDraft, markPristine, seededVersion, seededValue };
}

/**
 * The message `verifyVersion` (entity-commands.ts) throws as a `CommandConflictError` when a save's
 * `expectedVersion` no longer matches — the one case among the generic errors `saveEntityCommand`
 * surfaces that a settings page can act on specifically, by offering to reload or overwrite, rather
 * than just showing as an opaque failure.
 */
export const VERSION_CONFLICT_MESSAGE = "This record changed elsewhere. Reload before saving.";

export function isVersionConflictError(error: unknown): boolean {
  return error instanceof Error && error.message === VERSION_CONFLICT_MESSAGE;
}

/**
 * The settings pages lock on the one `user_preferences` version, which a location change, a phone
 * location ping or "I'm awake" also bumps, so a save can be refused as "changed on another device"
 * when none of the fields it sends changed. Given the server value the draft was seeded from, the
 * latest server value and the fields this save sends, says whether those fields are unchanged, in
 * which case the save is safe to repeat against the newer version instead of asking the user.
 */
export function sentFieldsUnchanged<T extends object>(seeded: T, latest: T, keys: readonly (keyof T)[]): boolean {
  return keys.every((key) => JSON.stringify(seeded[key] ?? null) === JSON.stringify(latest[key] ?? null));
}

/**
 * Repeats a refused save once against the newest version when `sentFieldsUnchanged` holds. Returns
 * true when the repeat saved; false when the conflict is real (or the repeat conflicted again), so
 * the caller shows its reload / keep-mine choice. Other errors from the repeat propagate.
 */
export async function retryFalseConflict<T extends object>(options: {
  seeded: T;
  readLatest: () => T & { version?: number | null | undefined };
  keys: readonly (keyof T)[];
  save: (expectedVersion: number | null) => Promise<void>;
}): Promise<boolean> {
  // The refused command refetches state before it throws; let that render land before reading it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const latest = options.readLatest();
  if (!sentFieldsUnchanged(options.seeded, latest, options.keys)) return false;
  try {
    await options.save(latest.version ?? null);
    return true;
  } catch (reason) {
    if (isVersionConflictError(reason)) return false;
    throw reason;
  }
}
