"use client";

import { useRef, useState } from "react";
import { usePortal } from "@/state/portal-provider";
import { readNow } from "@/shared/clock";
import { buildNowPanelView, type NowViewInput } from "@/features/diagnostics/now-view";
import { useModalFocus } from "@/shared/use-modal-focus";

interface Captured {
  id: string;
  warnings: string[];
}

/**
 * Freezes the moment a planning problem is on screen so it can be worked through later.
 *
 * The observation is taken when the panel opens, not when Capture is pressed. The clock and the
 * recommendation keep moving while the description is being typed, and the moment worth recording
 * is the one that prompted the report.
 */
export function ReportIssue({ view }: { view: NowViewInput }) {
  const { state, bannerText, replay } = usePortal();
  const panel = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [frozen, setFrozen] = useState<{ observedAt: string; view: NowViewInput } | null>(null);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [captured, setCaptured] = useState<Captured | null>(null);
  // `busy` disables the button, but only from the next render. Two clicks inside one frame would
  // both get through and write two rows for one report, so the guard is a ref as well.
  const inFlight = useRef(false);

  const close = () => {
    setOpen(false);
    setFrozen(null);
    setCaptured(null);
    setError("");
  };

  // Called from every render regardless of `replay`, and regardless of `open`: it's a hook, so it
  // can't sit behind the early return below. It only does anything while `active` (i.e. `open`) is true.
  const { onKeyDown } = useModalFocus({ active: open, trapRef: panel, onClose: close });

  // Capturing during a replay would pair a replayed page with live server state — evidence of a
  // moment that never happened.
  if (replay) return null;

  const start = () => {
    setFrozen({ observedAt: readNow().toISOString(), view });
    setDescription("");
    setError("");
    setCaptured(null);
    setOpen(true);
  };

  const capture = async () => {
    // Nothing is written until a description exists and this button is pressed. Opening the panel,
    // closing it, or pressing Capture with nothing typed must never leave a row behind.
    if (!frozen || !description.trim() || inFlight.current || captured) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/snapshots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          description: description.trim().slice(0, 4000),
          observedAt: frozen.observedAt,
          timezone: state.settings.timezone,
          url: window.location.href.slice(0, 2000),
          userAgent: navigator.userAgent.slice(0, 500),
          viewport: { width: Math.round(window.innerWidth), height: Math.round(window.innerHeight) },
          view: buildNowPanelView({ ...frozen.view, bannerText }),
          state
        })
      });
      const body = (await response.json()) as { id?: string; warnings?: string[]; error?: string };
      if (!response.ok || !body.id) throw new Error(body.error ?? "The snapshot could not be captured.");
      setCaptured({ id: body.id, warnings: body.warnings ?? [] });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "The snapshot could not be captured.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <div className="report-issue-trigger">
        <button type="button" className="quiet small" onClick={start}>
          Report issue
        </button>
      </div>
      {open && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <section
            ref={panel}
            className="report-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="report-issue-title"
            tabIndex={-1}
            onKeyDown={onKeyDown}
          >
            <header>
              <div>
                <p className="eyebrow">Report issue</p>
                <h2 id="report-issue-title">Snapshot this moment</h2>
              </div>
              <button type="button" className="icon-button" aria-label="Close issue report" onClick={close}>
                ×
              </button>
            </header>
            {captured ? (
              <div className="report-body">
                <p className="reason">
                  Captured. The database state, engine input and output, job queue, and this page are frozen at{" "}
                  {new Date(frozen!.observedAt).toLocaleString()}.
                </p>
                <p className="microcopy">
                  Snapshot <code>{captured.id}</code>
                </p>
                {captured.warnings.length > 0 && (
                  <div className="form-warning">
                    <strong>Captured with warnings</strong>
                    <ul>
                      {captured.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="actions">
                  <a className="button-link" href={`/api/snapshots/${captured.id}?download=1`}>
                    Download the file
                  </a>
                  <a className="button-link quiet" href={`/?snapshot=${captured.id}`}>
                    Open the replay
                  </a>
                  <button type="button" className="quiet" onClick={close}>
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <div className="report-body">
                <p className="reason">
                  Describe what is wrong with what you are seeing. Everything behind this page is recorded with it, so
                  the problem can be worked through later without the data having to still be in this state.
                </p>
                <label className="field">
                  <span>What is wrong?</span>
                  <textarea
                    rows={4}
                    value={description}
                    maxLength={4000}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="The recommendation is a task I finished this morning."
                  />
                </label>
                {error && (
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                )}
                <div className="actions">
                  <button type="button" disabled={busy || !description.trim()} onClick={() => void capture()}>
                    {busy ? "Capturing…" : "Capture snapshot"}
                  </button>
                  <button type="button" className="quiet" onClick={close}>
                    Cancel
                  </button>
                </div>
                <p className="microcopy">
                  {description.trim()
                    ? "Nothing is saved until you press Capture snapshot."
                    : "Describe the problem to enable Capture. Nothing has been saved yet, and closing this panel saves nothing."}
                </p>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
