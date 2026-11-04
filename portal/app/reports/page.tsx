"use client";

import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { useCallback, useEffect, useState } from "react";
import type { IssueSnapshotSummary } from "@openrhen/contracts";
import { usePortal } from "@/state/portal-provider";

const MODE_LABELS: Record<string, string> = {
  loading: "Still loading",
  activity_session: "Activity in progress",
  feedback: "Session checkpoint",
  action_session: "Session in progress",
  protected_commitment: "Protected commitment",
  sleep_due: "Sleep due",
  routine_due: "Preparation due",
  recommendation: "Recommended action",
  recovery: "Recovery",
  answer: "Question to answer",
  boundary: "Waiting for a boundary",
  nothing_fits: "Nothing fits"
};

export default function ReportsPage() {
  const { state } = usePortal();
  const timezone = state.settings.timezone;
  const [snapshots, setSnapshots] = useState<IssueSnapshotSummary[] | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/snapshots", { cache: "no-store" });
      const body = (await response.json()) as { snapshots?: IssueSnapshotSummary[]; error?: string };
      if (!response.ok || !body.snapshots) throw new Error(body.error ?? "Reported issues could not be loaded.");
      setSnapshots(body.snapshots);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Reported issues could not be loaded.");
      setSnapshots([]);
    }
  }, []);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- sets state only after the awaited request settles
    void load();
  }, [load]);

  const review = async (id: string, reviewed: boolean) => {
    setBusyId(id);
    setError("");
    try {
      const note = notes[id]?.trim();
      const response = await fetch(`/api/snapshots/${id}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewed, ...(reviewed && note ? { note } : {}) })
      });
      const body = (await response.json()) as { snapshot?: IssueSnapshotSummary; error?: string };
      if (!response.ok || !body.snapshot) throw new Error(body.error ?? "The review could not be saved.");
      setNotes((current) => ({ ...current, [id]: "" }));
      await load();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "The review could not be saved.");
    } finally {
      setBusyId("");
    }
  };

  const when = (value: string) =>
    dateTimeFormat(displayLocale(), { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(
      new Date(value)
    );

  if (!snapshots)
    return (
      <main className="content-page">
        <p className="eyebrow">Reports</p>
        <p>Loading reported issues…</p>
      </main>
    );

  const outstanding = snapshots.filter((item) => !item.reviewedAt);
  const reviewed = snapshots.filter((item) => item.reviewedAt);

  const card = (item: IssueSnapshotSummary) => (
    <article className="report-card" key={item.id}>
      <div className="section-heading">
        <div>
          <h2>{item.description}</h2>
          <p>
            {MODE_LABELS[item.mode] ?? item.mode} · seen {when(item.observedAt)} · {Math.round(item.sizeBytes / 1024)}{" "}
            KB{item.planningStatus ? ` · plan ${item.planningStatus}` : ""}
          </p>
        </div>
        <span className={`health ${item.reviewedAt ? "ahead" : "at_risk"}`}>
          {item.reviewedAt ? "reviewed" : "open"}
        </span>
      </div>
      {item.reviewedAt && (
        <p className="reason">
          Reviewed {when(item.reviewedAt)}
          {item.reviewNote ? ` — ${item.reviewNote}` : ". No note was recorded."}
        </p>
      )}
      <div className="actions">
        <a className="button-link" href={`/?snapshot=${item.id}`}>
          Open the replay
        </a>
        <a className="button-link" href={`/api/snapshots/${item.id}?download=1`}>
          Download
        </a>
        {item.reviewedAt ? (
          <button
            type="button"
            className="quiet"
            disabled={busyId === item.id}
            onClick={() => void review(item.id, false)}
          >
            {busyId === item.id ? "Reopening…" : "Reopen"}
          </button>
        ) : (
          <button type="button" disabled={busyId === item.id} onClick={() => void review(item.id, true)}>
            {busyId === item.id ? "Saving…" : "Mark reviewed"}
          </button>
        )}
      </div>
      {!item.reviewedAt && (
        <label className="field">
          <span>What was done about it? (optional, saved with the review)</span>
          <input
            value={notes[item.id] ?? ""}
            maxLength={2000}
            placeholder="Dropped the 15-hour lead on the two flexible steps."
            onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))}
          />
        </label>
      )}
    </article>
  );

  return (
    <main className="content-page">
      <h1>Reports</h1>
      <p className="reason">
        Issue snapshots captured from Now, outstanding first. Marking one reviewed records that it was dealt with; the
        captured evidence never changes.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <section>
        <div className="section-heading">
          <h2>Outstanding</h2>
          <span>{outstanding.length}</span>
        </div>
        {outstanding.length ? (
          outstanding.map(card)
        ) : (
          <p className="empty">Nothing outstanding. Report issue on the Now page captures a new one.</p>
        )}
      </section>

      {reviewed.length > 0 && (
        <section>
          <div className="section-heading">
            <h2>Reviewed</h2>
            <span>{reviewed.length}</span>
          </div>
          {reviewed.map(card)}
        </section>
      )}
    </main>
  );
}
