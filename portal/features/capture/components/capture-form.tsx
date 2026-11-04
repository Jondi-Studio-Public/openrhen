"use client";

import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import styles from "./capture-form.module.css";

const CAPTURE_DRAFT_STORAGE_KEY = "openrhen.capture-draft";
// The global `+` sheet drops its content once its close animation finishes (Sheet unmounts while
// fully closed), and a route change closes it — so a half-typed note has to survive outside this
// component's own state, or the "Review captured items" link inside the sheet would discard it.
// localStorage survives that; this module-level fallback covers the same case within one page load
// when storage itself is unavailable (private browsing, a disabled setting).
let draftFallback = "";

/** The draft as it stands, read by whoever needs to know if the box has been typed in since. */
export function readCaptureDraft(): string {
  if (typeof window === "undefined") return draftFallback;
  try {
    return window.localStorage.getItem(CAPTURE_DRAFT_STORAGE_KEY) ?? draftFallback;
  } catch {
    return draftFallback;
  }
}

/** Puts text back as the draft, for a form mounted after: how Undo returns a thought to the box. */
export function restoreCaptureDraft(value: string): void {
  writeCaptureDraft(value);
}

function writeCaptureDraft(value: string): void {
  draftFallback = value;
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(CAPTURE_DRAFT_STORAGE_KEY, value);
    else window.localStorage.removeItem(CAPTURE_DRAFT_STORAGE_KEY);
  } catch {
    // A browser that refuses storage still gets the draft held in memory, just not across a reload.
  }
}

/**
 * The one textarea that gets a thought out of your head. It writes a pending capture and nothing
 * else: the proposal waits under Needs review on the Capture page until it is classified. Used on
 * that page and inside the global `+` sheet, so it owns its own text and error and takes the save
 * function from whoever renders it.
 */
export function CaptureForm({
  addCapture,
  id = "capture",
  autoFocus = false,
  onSaved,
  onType
}: {
  addCapture: (text: string) => Promise<string | void>;
  /** The textarea id; overridden when a page and the sheet could both be mounted at once. */
  id?: string;
  autoFocus?: boolean;
  /** Called after a save, with what was saved and the new capture's id when the save returns one. */
  onSaved?: (saved: { text: string; id?: string }) => void;
  /** Called on every edit, so a note about the last save can clear once you start the next thought. */
  onType?: () => void;
}) {
  const [text, setText] = useState(() => readCaptureDraft());
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  // A ref as well as state: two sends in one tick (a key repeat) both read the same stale `pending`.
  const sending = useRef(false);
  const box = useRef<HTMLTextAreaElement>(null);

  const changeText = (value: string) => {
    setText(value);
    writeCaptureDraft(value);
    onType?.();
  };

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    // A double tap while the first submission is still in flight would otherwise fire `addCapture`
    // twice and leave two proposals under Needs review for one thought.
    if (sending.current || !text.trim()) return;
    sending.current = true;
    setPending(true);
    try {
      const saved = text.trim();
      const captureId = await addCapture(saved);
      setText("");
      writeCaptureDraft("");
      setError("");
      // Ready for the next thought without a tap, which is what a desk keyboard and a phone both want.
      box.current?.focus();
      onSaved?.({ text: saved, ...(typeof captureId === "string" ? { id: captureId } : {}) });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Capture was not saved.");
    } finally {
      sending.current = false;
      setPending(false);
    }
  }

  // Enter adds a line; Ctrl or Cmd Enter sends, as in a mail or chat box.
  const sendFromKeyboard = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter that confirms an IME composition (Japanese, Chinese, Korean) is not a send.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <form className={`capture-form ${styles.form}`} onSubmit={submit}>
      {/* Add sits beside the label, at the top and sticky, so a phone keyboard rising under the box can
          never hide it. */}
      <div className={styles.bar}>
        <label htmlFor={id}>Task, deadline, idea, or commitment</label>
        {/* Nothing typed, nothing to add: the button says so rather than ignoring the press. */}
        <button className={styles.add} disabled={pending || !text.trim()} aria-busy={pending}>
          Add to Captured
        </button>
      </div>
      <textarea
        ref={box}
        id={id}
        value={text}
        autoFocus={autoFocus}
        aria-keyshortcuts="Control+Enter Meta+Enter"
        onChange={(event) => changeText(event.target.value)}
        onKeyDown={sendFromKeyboard}
        placeholder="Networking assignment due next Friday…"
      />
      <p className={styles.hint}>Ctrl+Enter or Cmd+Enter adds it.</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
