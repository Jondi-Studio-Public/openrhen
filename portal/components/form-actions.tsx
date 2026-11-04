"use client";

import { createClientId } from "@/shared/client-id";
import { useCallback, useRef, useState, type FormEvent } from "react";

/**
 * Guards a form's submit handler against re-entry. Every create submit mints a fresh entity id, so a
 * second tap (or Enter) before the first response is a second record; while the handler's promise is
 * unsettled further submits are swallowed and `pending` disables the button. A ref carries the guard
 * because two submits can land before React re-renders.
 */
export function useSubmitGuard<R>(handler: (event: FormEvent) => R | Promise<R>) {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  /** Runs any action under the same guard, for buttons that save without being a form submit. */
  const run = useCallback(async <T,>(action: () => T | Promise<T>): Promise<T | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setPending(true);
    try {
      return await action();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, []);
  const onSubmit = useCallback(
    async (event: FormEvent): Promise<R | undefined> => {
      if (inFlight.current) event.preventDefault();
      return run(() => handler(event));
    },
    [handler, run]
  );
  return { pending, onSubmit, run };
}

/**
 * One entity id per open create draft. The first `current()` mints it and later calls return the same
 * id until `reset()`, so a retry after a lost response (the server did write the first) re-sends the
 * same id and cannot create a second record. Call `reset()` when the draft closes, is replaced, or saves.
 */
export function useDraftId() {
  const id = useRef<string | null>(null);
  const current = useCallback(() => (id.current ??= createClientId()), []);
  const reset = useCallback(() => {
    id.current = null;
  }, []);
  return { current, reset };
}

/** The submit row every editor ends with; cancelling is only offered while editing. */
export function FormActions({
  editing,
  cancel,
  pending = false
}: {
  editing: boolean;
  cancel: () => void;
  /** A submit is in flight: the submit button is disabled so it cannot be sent twice. */
  pending?: boolean;
}) {
  return (
    <div className="form-actions">
      <button type="submit" disabled={pending} aria-busy={pending || undefined}>
        {editing ? "Save changes" : "Add"}
      </button>
      {editing && (
        <button type="button" className="quiet" onClick={cancel}>
          Cancel
        </button>
      )}
    </div>
  );
}
