"use client";

import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CatchUpEntry, CatchUpLedger, SettleCatchUpResult } from "@openrhen/contracts";
import { usePortal } from "@/state/portal-provider";
import { createClientId } from "@/shared/client-id";
import { readNow } from "@/shared/clock";
import { fetchCatchUp, postSettle } from "../catch-up-client";
import {
  EMPTY_DECISIONS,
  applyToEntries,
  buildSettleCommand,
  choiceLabel,
  decidedEntries,
  defaultAt,
  groupEntries,
  pruneDecisions,
  rightNowEntries,
  setAt,
  setChoice,
  setMoveTo,
  setRemaining,
  skipOlderThanCommand,
  type CatchUpChoice,
  type CatchUpDecisions
} from "../catch-up-model";

const STORAGE_KEY = "openrhen:catch-up-decisions";

function loadDecisions(): CatchUpDecisions {
  if (typeof window === "undefined") return EMPTY_DECISIONS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_DECISIONS;
    const parsed = JSON.parse(raw) as Partial<CatchUpDecisions>;
    return {
      choices: parsed.choices ?? {},
      moveTo: parsed.moveTo ?? {},
      at: parsed.at ?? {},
      remaining: parsed.remaining ?? {},
      note: typeof parsed.note === "string" ? parsed.note : ""
    };
  } catch {
    return EMPTY_DECISIONS;
  }
}

function saveDecisions(decisions: CatchUpDecisions) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(decisions));
  } catch {
    // Choices are a convenience; the page works without storage.
  }
}

function dayHeading(day: string): string {
  return dateTimeFormat(displayLocale(), { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(`${day}T12:00:00Z`)
  );
}

function kindNote(entry: CatchUpEntry): string | null {
  if (entry.kind === "self_set_deadline") return "Your own date has lapsed. Still wanted?";
  if (entry.kind === "external_deadline") return "A date set by someone else has passed.";
  return entry.question;
}

/**
 * `/catch-up`: settle what was planned while away. Days newest first, one
 * card per entry. Choices are held on the page and in local storage and sent in one settle; nothing
 * is written until Settle. Single column so it works on a phone.
 */
export function CatchUpPage() {
  const { state, acceptServerState } = usePortal();
  const timezone = state.settings.timezone;
  const [ledger, setLedger] = useState<CatchUpLedger | null>(null);
  const [loadError, setLoadError] = useState("");
  const [decisions, setDecisions] = useState<CatchUpDecisions>(loadDecisions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lastResult, setLastResult] = useState<SettleCatchUpResult | null>(null);
  // One id per attempt, kept across a retry of the same choices so a lost response replays.
  const commandId = useRef(createClientId());

  const [reads, setReads] = useState(0);
  const load = useCallback(() => setReads((count) => count + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetchCatchUp({ all: true })
      .then((next) => {
        if (cancelled) return;
        setLedger(next);
        setLoadError("");
        setDecisions((current) => pruneDecisions(current, next.entries));
      })
      .catch(() => {
        if (!cancelled) setLoadError("Catch-up could not be loaded. Check the connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [reads]);

  const update = (next: CatchUpDecisions) => {
    commandId.current = createClientId();
    setDecisions(next);
    saveDecisions(next);
  };

  const entries = useMemo(() => ledger?.entries ?? [], [ledger]);
  const rightNow = useMemo(() => rightNowEntries(entries), [entries]);
  const days = useMemo(() => groupEntries(entries, timezone), [entries, timezone]);
  const decided = decidedEntries(decisions, entries);
  const kept = entries.filter((entry) => decisions.choices[entry.id] === "pending" && !decided.includes(entry)).length;
  const undecided = entries.length - decided.length - kept;
  // Closing needs every entry resolved: an entry kept open stays listed, so the window cannot close.
  const closes = decided.length === entries.length && ledger?.remaining === 0;

  const [olderDays, setOlderDays] = useState("7");
  const olderCount = Number(olderDays);
  const olderValid = olderDays !== "" && Number.isInteger(olderCount) && olderCount >= 0 && olderCount <= 3650;

  async function skipOlder() {
    if (!olderValid || busy) return;
    setBusy(true);
    setError("");
    try {
      const { result, state: fresh } = await postSettle(skipOlderThanCommand(olderCount, createClientId()));
      if (fresh) acceptServerState(fresh);
      setLastResult(result);
      load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The settle was not saved.");
    } finally {
      setBusy(false);
    }
  }

  async function settle(closeWindow: boolean) {
    const command = buildSettleCommand(decisions, entries, {
      commandId: commandId.current,
      timezone,
      closeWindow
    });
    if (!command || busy) return;
    setBusy(true);
    setError("");
    try {
      const { result, state: fresh } = await postSettle(command);
      if (fresh) acceptServerState(fresh);
      setLastResult(result);
      const applied = new Set(
        result.results.filter((entry) => entry.outcome === "applied").map((entry) => entry.entryId)
      );
      const kept: CatchUpDecisions = {
        choices: Object.fromEntries(Object.entries(decisions.choices).filter(([id]) => !applied.has(id))),
        moveTo: Object.fromEntries(Object.entries(decisions.moveTo).filter(([id]) => !applied.has(id))),
        at: Object.fromEntries(Object.entries(decisions.at ?? {}).filter(([id]) => !applied.has(id))),
        remaining: Object.fromEntries(Object.entries(decisions.remaining ?? {}).filter(([id]) => !applied.has(id))),
        note: result.results.some((entry) => entry.outcome !== "applied") ? decisions.note : ""
      };
      commandId.current = createClientId();
      setDecisions(kept);
      saveDecisions(kept);
      load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The settle was not saved.");
    } finally {
      setBusy(false);
    }
  }

  if (loadError)
    return (
      <section className="catch-up" role="alert">
        <p>{loadError}</p>
        <button type="button" className="secondary" onClick={load}>
          Try again
        </button>
      </section>
    );
  if (!ledger) return <p className="muted">Looking for what needs settling…</p>;

  function renderEntry(entry: CatchUpEntry) {
    const choice = decisions.choices[entry.id];
    const note = kindNote(entry);
    const needsAt = choice !== undefined && entry.atRequired.includes(choice);
    const choose = (option: CatchUpChoice) => {
      if (choice === option) return update(setChoice(decisions, entry.id, null));
      let next = setChoice(decisions, entry.id, option);
      if (entry.atRequired.includes(option) && !next.at?.[entry.id])
        next = setAt(next, entry.id, defaultAt(entry, readNow(), timezone));
      update(next);
    };
    return (
      <article key={entry.id} className="catch-up-entry" data-choice={choice ?? "none"}>
        <h3>{entry.title}</h3>
        {note && <p className="catch-up-kind">{note}</p>}
        <div className="catch-up-choices" role="group" aria-label={`Outcome for ${entry.title}`}>
          {entry.verdicts.map((option: CatchUpChoice) => (
            <button
              key={option}
              type="button"
              className={choice === option ? "selected" : "quiet"}
              aria-pressed={choice === option}
              onClick={() => choose(option)}
            >
              {choiceLabel(entry.kind, option)}
            </button>
          ))}
        </div>
        {needsAt && (
          <label className="catch-up-move">
            {choice === "ended" ? "Stopped at" : entry.kind === "stale_wake" ? "Woke at" : "When"}
            <input
              type="datetime-local"
              value={decisions.at?.[entry.id] ?? ""}
              onChange={(event) => update(setAt(decisions, entry.id, event.target.value))}
            />
          </label>
        )}
        {choice === "ended" && entry.asksRemainingMinutes && (
          <label className="catch-up-move">
            Minutes left (optional)
            <input
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              value={decisions.remaining?.[entry.id] ?? ""}
              onChange={(event) => update(setRemaining(decisions, entry.id, event.target.value))}
            />
          </label>
        )}
        {(entry.kind === "self_set_deadline" || entry.kind === "external_deadline") && choice === "pending" && (
          <label className="catch-up-move">
            New date (optional)
            <input
              type="date"
              value={decisions.moveTo[entry.id] ?? ""}
              onChange={(event) => update(setMoveTo(decisions, entry.id, event.target.value))}
            />
          </label>
        )}
      </article>
    );
  }

  const conflicts =
    lastResult?.results.filter((entry) => entry.outcome === "conflict" || entry.outcome === "invalid") ?? [];

  return (
    <section className="catch-up">
      {entries.length === 0 ? (
        <p className="catch-up-empty">
          {lastResult?.closed
            ? "Caught up. The plan has been recalculated."
            : "Nothing to settle. Everything planned has an outcome."}
        </p>
      ) : (
        <p className="catch-up-intro">
          {ledger.since ? "Anything you did not record since you were last here is listed. " : ""}
          Pick an outcome for each, then settle them all at once.
        </p>
      )}
      {conflicts.length > 0 && (
        <div className="catch-up-conflicts" role="alert">
          <p>These did not apply and are still listed:</p>
          <ul>
            {conflicts.map((entry) => (
              <li key={entry.entryId}>
                {entries.find((candidate) => candidate.id === entry.entryId)?.title ?? entry.entryId}:{" "}
                {entry.message ?? "it changed since you opened this page."}
              </li>
            ))}
          </ul>
        </div>
      )}
      {rightNow.length > 0 && (
        <section className="catch-up-day" aria-label="Right now">
          <header className="catch-up-day-head">
            <h2>Right now</h2>
          </header>
          <div className="catch-up-project">{rightNow.map((entry) => renderEntry(entry))}</div>
        </section>
      )}
      {days.map((group) => {
        const dayActions = group.projects.flatMap((project) =>
          project.entries.filter((entry) => entry.kind === "occurrence")
        );
        return (
          <section key={group.day} className="catch-up-day" aria-label={dayHeading(group.day)}>
            <header className="catch-up-day-head">
              <h2>{dayHeading(group.day)}</h2>
              {dayActions.length > 0 && (
                <button
                  type="button"
                  className="quiet small"
                  onClick={() => update(applyToEntries(decisions, dayActions, "skipped"))}
                >
                  Skip this day&apos;s actions
                </button>
              )}
            </header>
            {group.projects.map((project) => (
              <div key={project.projectId ?? "none"} className="catch-up-project">
                {project.entries.map((entry) => {
                  return renderEntry(entry);
                })}
              </div>
            ))}
          </section>
        );
      })}
      {entries.length > 0 && (
        <div className="catch-up-older">
          <label className="catch-up-move">
            Skip everything older than (days)
            <input
              type="number"
              min={0}
              max={3650}
              step={1}
              inputMode="numeric"
              value={olderDays}
              onChange={(event) => setOlderDays(event.target.value)}
            />
          </label>
          <button type="button" className="quiet" disabled={busy || !olderValid} onClick={() => void skipOlder()}>
            Skip older ones
          </button>
        </div>
      )}
      {entries.length > 0 && (
        <label className="catch-up-note">
          What happened instead (optional)
          <textarea
            rows={3}
            maxLength={2000}
            value={decisions.note}
            onChange={(event) => update({ ...decisions, note: event.target.value })}
          />
        </label>
      )}
      {error && (
        <p className="catch-up-error" role="alert">
          {error}
        </p>
      )}
      <div className="catch-up-bar">
        <span aria-live="polite">
          {entries.length === 0
            ? "All settled"
            : `${undecided} left to choose · ${decided.length} to settle${kept > 0 ? ` · ${kept} kept open` : ""}`}
        </span>
        {entries.length > 0 && (
          <button type="button" disabled={busy || decided.length === 0} onClick={() => void settle(closes)}>
            {busy ? "Settling…" : closes ? "Settle and close" : "Settle chosen"}
          </button>
        )}
      </div>
    </section>
  );
}
