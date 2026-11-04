import { useSyncExternalStore } from "react";
import type { CloseEntityResult } from "@openrhen/contracts";

/**
 * The one toast the close and restore buttons share. It lives outside any page (the shell mounts its region once), so
 * it survives the navigation that a close often causes, and a second close replaces the first.
 */
export type CloseToast =
  | { key: number; kind: "closed"; title: string; closed: CloseEntityResult }
  | { key: number; kind: "notice"; text: string };

type NewToast =
  | { kind: "closed"; title: string; closed: CloseEntityResult }
  | { kind: "notice"; text: string };

let current: CloseToast | null = null;
let counter = 0;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

export const closeToasts = {
  show(toast: NewToast): void {
    counter += 1;
    current = { ...toast, key: counter };
    emit();
  },
  /** Dismisses the toast with this key; a newer toast that replaced it is left alone. */
  dismiss(key: number): void {
    if (current?.key !== key) return;
    current = null;
    emit();
  },
  clear(): void {
    current = null;
    emit();
  },
  get(): CloseToast | null {
    return current;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
};

export function useCloseToast(): CloseToast | null {
  return useSyncExternalStore(closeToasts.subscribe, closeToasts.get, () => null);
}
