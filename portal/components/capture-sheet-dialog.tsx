"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { usePortal } from "@/state/portal-provider";
import { captureSheetTitle, type CaptureSheetMode } from "@/shared/capture-sheet";
import { closeCaptureSheet, setCaptureSheetMode, useCaptureSheet } from "@/shared/use-capture-sheet";
import { CaptureForm, readCaptureDraft, restoreCaptureDraft } from "@/features/capture/components/capture-form";
import { captureIgnoreCommand } from "@/features/capture/capture-commands";
import { DisruptionCaptureForm } from "@/features/disruptions/components/disruption-capture-form";
import { importPanelExtensions } from "@/features/imports/import-panel-extensions";
import { ImportPanels } from "@/features/inbox/components/import-panels";
import { Button } from "./ui/button";
import { Sheet } from "./sheet";
import styles from "./capture-sheet-dialog.module.css";

/** The tabs in order; a registered import extension sits after Workbook or CSV, before Something came up. */
function sheetModes(): { value: CaptureSheetMode; label: string }[] {
  return [
    { value: "capture", label: "Capture" },
    { value: "paste", label: "Paste or photo" },
    { value: "workbook", label: "Workbook or CSV" },
    ...importPanelExtensions().map(({ id, label }) => ({ value: id, label })),
    { value: "disruption", label: "Something came up" }
  ];
}

/** The last thing saved, kept for the line under the box. */
interface Saved {
  id?: string;
  text: string;
  undone: boolean;
  /** Whether Undo put the text back in the box; false when something new was typed meanwhile. */
  restored?: boolean;
}

/** A long thought is shortened in the confirmation, never in what was saved. */
function brief(text: string): string {
  const line = text.replace(/\s+/g, " ");
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}

/**
 * The one sheet for getting something in, opened by the `+` button, Ctrl K and the Inbox's Add button.
 * Capture is a thought that waits in Captured; Paste or photo, Workbook or CSV and any registered provider pull read into a
 * batch you check; Disruption is real straight away. Its content is mounted only while the sheet is
 * open, so each opening starts clean.
 */
export function CaptureSheetDialog() {
  const sheet = useCaptureSheet();
  return (
    <Sheet
      open={sheet.open}
      onClose={closeCaptureSheet}
      title={captureSheetTitle(sheet.mode)}
      className="capture-sheet"
    >
      <CaptureSheetBody />
    </Sheet>
  );
}

function CaptureSheetBody() {
  const sheet = useCaptureSheet();
  const { state, addCapture, saveEntityCommand, runActivityCommand } = usePortal();
  const [saved, setSaved] = useState<Saved | null>(null);
  const [undoError, setUndoError] = useState("");
  const [undoing, setUndoing] = useState(false);
  // Remounting the form is how Undo hands the text back to the box: it reads the draft on mount.
  const [formKey, setFormKey] = useState(0);
  // Undo runs seconds after the save it reverses, so it reads the state as it is then.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  // The capture as first seen in state after the save. Undo only goes ahead while it is still that
  // version and still waiting; anything newer (confirmed, edited, ignored elsewhere) is left alone.
  const baseline = useRef<{ id: string; version: number | null } | null>(null);
  useEffect(() => {
    if (!saved?.id || baseline.current?.id === saved.id) return;
    const seen = state.captures.find((item) => item.id === saved.id);
    if (seen) baseline.current = { id: saved.id, version: seen.version ?? null };
  }, [state, saved]);
  const waiting = state.captures.filter((item) => item.status === "pending").length;

  async function undo() {
    if (!saved?.id || undoing) return;
    const now = stateRef.current.captures.find((item) => item.id === saved.id);
    const seen = baseline.current?.id === saved.id ? baseline.current : null;
    if (now && (now.status !== "pending" || (seen && (now.version ?? null) !== seen.version))) {
      setUndoError("It changed after you saved it, so Undo left it alone.");
      return;
    }
    const command = captureIgnoreCommand(saved.id, new Date().toISOString(), stateRef.current);
    if (!command) {
      setUndoError("It could not be undone yet. Try again in a moment.");
      return;
    }
    // What the box held when Undo was pressed: the text goes back only if it still holds that.
    const draftAtPress = readCaptureDraft();
    setUndoing(true);
    try {
      await saveEntityCommand(command);
      setUndoError("");
      const untouched = readCaptureDraft() === draftAtPress;
      if (untouched) {
        restoreCaptureDraft(saved.text);
        setFormKey((key) => key + 1);
      }
      setSaved({ ...saved, undone: true, restored: untouched });
    } catch (error) {
      setUndoError(error instanceof Error ? error.message : "It could not be undone.");
    } finally {
      setUndoing(false);
    }
  }

  const paneId = "capture-sheet-pane";
  const modes = sheetModes();
  const tablist = useRef<HTMLDivElement>(null);
  const focusTab = useRef<number | null>(null);
  useEffect(() => {
    if (focusTab.current === null) return;
    tablist.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[focusTab.current]?.focus();
    focusTab.current = null;
  }, [sheet.mode]);
  // ARIA tabs: one tab stop (the selected tab), and the arrow keys, Home and End move between tabs.
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, at: number) => {
    if (event.nativeEvent.isComposing) return;
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const to =
      event.key === "Home" ? 0 : event.key === "End" ? modes.length - 1 : (at + step + modes.length) % modes.length;
    if (!step && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    if (modes[to]!.value === sheet.mode) return;
    setCaptureSheetMode(modes[to]!.value);
    // After the new pane mounts: a pane that focuses its own field (Capture) would otherwise take it.
    focusTab.current = to;
  };
  return (
    <>
      <div ref={tablist} className={`capture-mode-switch ${styles.modes}`} role="tablist" aria-label="What this is">
        {modes.map((option, at) => (
          <button
            key={option.value}
            type="button"
            className={`quiet small${sheet.mode === option.value ? " selected" : ""}`}
            role="tab"
            aria-selected={sheet.mode === option.value}
            aria-controls={paneId}
            tabIndex={sheet.mode === option.value ? 0 : -1}
            onKeyDown={(event) => onTabKey(event, at)}
            onClick={() => {
              focusTab.current = null;
              setCaptureSheetMode(option.value);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div id={paneId} role="tabpanel" className={styles.pane}>
        {sheet.mode === "disruption" ? (
          <>
            {/* The opposite promise to the capture half's, and the reason the two are kept apart. */}
            <p className="reason">This is real straight away. Your day replans around it.</p>
            <DisruptionCaptureForm
              // The sheet does not remount on every open — only on close, or on switching away from
              // this half and back — so a second **Let … know?** offer clicked while it is already
              // open in this mode would otherwise reuse the mounted form's stale draft (seeded once,
              // in its `useState` initializer). Keying on the preset itself forces a fresh mount
              // whenever it names a different contact or commitment.
              key={
                sheet.disruptionPreset
                  ? `${sheet.disruptionPreset.contactId ?? ""}:${sheet.disruptionPreset.about ?? ""}:${sheet.disruptionPreset.reason ?? ""}`
                  : "no-preset"
              }
              state={state}
              saveEntityCommand={saveEntityCommand}
              runActivityCommand={runActivityCommand}
              onSaved={() => closeCaptureSheet()}
              preset={sheet.disruptionPreset}
            />
          </>
        ) : sheet.mode === "capture" ? (
          <>
            <p className="reason">
              Get it out of your head. It waits in Captured and cannot change your plan until you confirm it.
            </p>
            <CaptureForm
              key={formKey}
              addCapture={addCapture}
              id="capture-sheet-text"
              autoFocus
              onSaved={(next) => {
                baseline.current = null;
                setUndoError("");
                setSaved({ ...next, undone: false });
              }}
              onType={() => {
                if (saved) setSaved(null);
                if (undoError) setUndoError("");
              }}
            />
            {/* Its height is held, so the sheet does not jump when "Saved" appears or goes. */}
            <div className="capture-saved">
              {/* Always mounted, so a screen reader announces the text when it fills in. */}
              <p className="microcopy" role="status">
                {saved &&
                  (saved.undone ? (
                    <>
                      Undone: &ldquo;{brief(saved.text)}&rdquo;
                      {saved.restored ? " is back in the box." : " is ignored. Your new text is kept."}
                    </>
                  ) : (
                    <>
                      Saved: &ldquo;{brief(saved.text)}&rdquo; ({waiting} {waiting === 1 ? "capture" : "captures"}{" "}
                      waiting)
                    </>
                  ))}
              </p>
              {saved?.id && !saved.undone ? (
                <p className="microcopy">
                  <a href={`/inbox/captured?item=capture:${encodeURIComponent(saved.id)}`}>See it in Captured</a>
                  {" · "}
                  <Button variant="ghost" size="sm" disabled={undoing} onClick={() => void undo()}>
                    Undo
                  </Button>
                </p>
              ) : (
                <p className="microcopy">
                  <a href="/inbox/captured">Review captured items</a>
                </p>
              )}
              {undoError && (
                <p className="form-error" role="alert">
                  {undoError}
                </p>
              )}
            </div>
          </>
        ) : (
          <ImportPanels panel={sheet.mode} onNavigate={closeCaptureSheet} />
        )}
      </div>
    </>
  );
}
