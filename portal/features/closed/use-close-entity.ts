"use client";

import { useCallback, useRef, useState } from "react";
import type { CloseEntityResult, CloseType, CloseVerb } from "@openrhen/contracts";
import { createClientId } from "@/shared/client-id";
import { usePortal } from "@/state/portal-provider";
import {
  closeCommandFor,
  failureText,
  isChildrenRefusal,
  restoreCommandFor,
  restoreToastText,
  type CloseTarget
} from "./close-commands";
import { closeToasts } from "./close-toast-store";

export type CloseOutcome =
  | { ok: true; closed: CloseEntityResult }
  | { ok: false; needsConfirm: true }
  | { ok: false; busy: true }
  | { ok: false; message: string };

export type RestoreOutcome =
  | { ok: true; closed: CloseEntityResult }
  | { ok: false; busy: true }
  | { ok: false; message: string; status?: number };

export interface PendingChildren {
  target: CloseTarget;
  verb: CloseVerb;
  /** The server's own sentence: the count and the named children with deadlines. */
  message: string;
}

export interface RestoreRow {
  type: CloseType;
  id: string;
  title: string;
  restoreVerb: CloseVerb;
  version: number;
}

/**
 * Close and restore one row from the portal: the logic behind the Archive, Cancel and Restore buttons.
 *
 * - One request at a time per hook; a second click while one is in flight does nothing.
 * - One command id per (row, call, version) until it succeeds, so a retry after a lost answer replays the receipt
 *   instead of closing twice, and the "Close all" resend after a refusal reuses the id (a refused close rolls its
 *   receipt claim back, so nothing is stored under it).
 * - The refusals this hook handles itself (the children question, a stale version, a closed parent) do not light the
 *   shared save banner; any other failure comes back as text for the caller to show beside the button.
 * - A success shows the shared toast; a close carries Undo.
 */
export function useCloseEntity() {
  const { closeEntityCommand } = usePortal();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<PendingChildren | null>(null);
  const inFlight = useRef(false);
  const ids = useRef(new Map<string, string>());

  const idFor = (key: string): string => {
    let id = ids.current.get(key);
    if (id === undefined) {
      id = createClientId();
      ids.current.set(key, id);
    }
    return id;
  };

  const close = useCallback(
    async (target: CloseTarget, verb: CloseVerb, options: { includeChildren?: boolean } = {}): Promise<CloseOutcome> => {
      if (inFlight.current) return { ok: false, busy: true };
      inFlight.current = true;
      setBusy(true);
      setError("");
      const key = `close:${target.type}:${target.id}:${target.version}:${verb}`;
      try {
        const closed = await closeEntityCommand(
          closeCommandFor(target, verb, { commandId: idFor(key), ...options }),
          { handles: () => true }
        );
        ids.current.delete(key);
        setPending(null);
        closeToasts.show({ kind: "closed", title: target.title, closed });
        return { ok: true, closed };
      } catch (caught) {
        if (isChildrenRefusal(caught) && options.includeChildren !== true) {
          setPending({ target, verb, message: caught.message });
          return { ok: false, needsConfirm: true };
        }
        const message = failureText(caught, "close");
        setError(message);
        return { ok: false, message };
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    // `idFor` only touches refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [closeEntityCommand]
  );

  const restore = useCallback(
    async (row: RestoreRow, options: { includeChildren?: boolean } = {}): Promise<RestoreOutcome> => {
      if (inFlight.current) return { ok: false, busy: true };
      inFlight.current = true;
      setBusy(true);
      setError("");
      const key = `restore:${row.type}:${row.id}:${row.version}:${options.includeChildren === true}`;
      try {
        const closed = await closeEntityCommand(restoreCommandFor(row, { commandId: idFor(key), ...options }), {
          handles: () => true
        });
        ids.current.delete(key);
        closeToasts.show({ kind: "notice", text: restoreToastText(row.title, closed) });
        return { ok: true, closed };
      } catch (caught) {
        const message = failureText(caught, "restore");
        setError(message);
        const status = (caught as { status?: unknown }).status;
        return { ok: false, message, ...(typeof status === "number" ? { status } : {}) };
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [closeEntityCommand]
  );

  const confirmChildren = useCallback(async (): Promise<CloseOutcome> => {
    if (!pending) return { ok: false, message: "Nothing is waiting to be closed." };
    return close(pending.target, pending.verb, { includeChildren: true });
  }, [close, pending]);

  const dismissChildren = useCallback(() => setPending(null), []);

  return { close, restore, confirmChildren, dismissChildren, pending, busy, error };
}

