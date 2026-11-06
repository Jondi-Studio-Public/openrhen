"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  WATCH_IMPORT_MAX_FILE_BYTES,
  type WatchHistoryReview,
  type WatchImportResult,
  type WatchLengthsFetchResult
} from "@openrhen/contracts";
import { Sheet } from "@/components/sheet";
import { Button } from "@/components/ui/button";
import { displayLocale } from "@/shared/locale";
import {
  emptyWindowLine,
  estimateCaveat,
  estimateLine,
  fileToBase64,
  hourLabel,
  lengthsLine,
  looksLikeZip,
  shortDate
} from "../watch-history-view";
import styles from "./watch-history-panel.module.css";

type Load = { status: "loading" } | { status: "failed" } | { status: "ready"; review: WatchHistoryReview };

async function readReview(): Promise<Load> {
  try {
    const response = await fetch("/api/review/watch-history", { cache: "no-store" });
    if (!response.ok) return { status: "failed" };
    return { status: "ready", review: (await response.json()) as WatchHistoryReview };
  } catch {
    return { status: "failed" };
  }
}

function importedText(result: WatchImportResult): string {
  if (result.added === 0) return "Nothing new: every entry in that file was already imported.";
  const parts = [`${result.watches} ${result.watches === 1 ? "watch" : "watches"} added`];
  if (result.music > 0)
    parts.push(`${result.music} YouTube Music ${result.music === 1 ? "play" : "plays"} kept, not counted`);
  if (result.ads > 0) parts.push(`${result.ads} ${result.ads === 1 ? "ad" : "ads"} kept, not counted`);
  if (result.posts > 0) parts.push(`${result.posts} ${result.posts === 1 ? "post" : "posts"} kept, not counted`);
  if (result.alreadyHeld > 0) parts.push(`${result.alreadyHeld} already held`);
  if (result.skipped > 0) parts.push(`${result.skipped} skipped for lacking a time`);
  return `${parts.join(", ")}.`;
}

/**
 * Review's watch-history panel: how many videos were watched per day and per hour over the last 30 days, from a
 * Google Takeout file the person imports here, and a time estimate labelled as one. Self-fetching and information
 * only: the engine never sees these rows. It shows nothing it does not have: no data is an explanation, a failed
 * read is said, and the estimate is a range.
 */
export function WatchHistoryPanel() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [lengthsMessage, setLengthsMessage] = useState("");
  const [problem, setProblem] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [fetchingLengths, setFetchingLengths] = useState(false);

  const refresh = useCallback(async () => {
    const next = await readReview();
    setLoad(next);
    return next;
  }, []);
  useEffect(() => {
    let cancelled = false;
    void readReview().then((next) => {
      if (!cancelled) setLoad(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const close = () => {
    setOpen(false);
    setFile(null);
    setProblem("");
  };

  /** Looks up lengths in rounds of up to 1,000 videos until none remain, the server stops, or a round makes no progress. */
  const runLengths = async () => {
    setFetchingLengths(true);
    setLengthsMessage("Fetching video lengths…");
    try {
      for (let round = 0; round < 500; round += 1) {
        const response = await fetch("/api/review/watch-history/lengths", { method: "POST" });
        const result = (await response.json().catch(() => null)) as WatchLengthsFetchResult | null;
        if (!response.ok || !result?.message) {
          setLengthsMessage("Video lengths could not be fetched just now. Nothing was lost; try again.");
          break;
        }
        setLengthsMessage(result.message);
        if (result.stopped !== null || result.remaining === 0 || result.fetched === 0) break;
      }
    } catch {
      setLengthsMessage("Video lengths could not be fetched just now. Nothing was lost; try again.");
    } finally {
      setFetchingLengths(false);
      await refresh();
    }
  };

  const upload = async () => {
    if (!file || busy) return;
    if (file.size > WATCH_IMPORT_MAX_FILE_BYTES) {
      setProblem(
        `That file is ${Math.round(file.size / 1048576)} MB; the limit is ${Math.round(WATCH_IMPORT_MAX_FILE_BYTES / 1048576)} MB. Export a shorter date range from Takeout.`
      );
      return;
    }
    setBusy(true);
    setProblem("");
    try {
      const zip = await looksLikeZip(file);
      const body = JSON.stringify({
        filename: file.name,
        encoding: zip ? "base64" : "text",
        data: zip ? await fileToBase64(file) : await file.text()
      });
      const response = await fetch("/api/imports/watch-history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body
      });
      const payload = (await response.json().catch(() => null)) as (WatchImportResult & { error?: string }) | null;
      if (!response.ok || !payload) {
        setProblem(payload?.error ?? "The import failed. Nothing was added.");
        return;
      }
      setMessage(importedText(payload));
      setLengthsMessage("");
      close();
      const next = await refresh();
      // A saved key means the new videos' lengths can be fetched now; without one the panel says how to add it.
      if (next.status === "ready" && next.review.lengths.keyState === "set") void runLengths();
    } catch {
      setProblem("The import failed. Nothing was added.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (deletingId) return;
    setDeletingId(id);
    setMessage("");
    try {
      const response = await fetch(`/api/imports/watch-history/${encodeURIComponent(id)}`, { method: "DELETE" });
      const payload = response.ok ? ((await response.json().catch(() => null)) as { removed?: number } | null) : null;
      setMessage(
        response.ok
          ? `Import deleted${typeof payload?.removed === "number" ? `: ${payload.removed} ${payload.removed === 1 ? "entry" : "entries"} removed` : ""}.`
          : "That import could not be deleted."
      );
    } catch {
      setMessage("That import could not be deleted.");
    }
    await refresh();
    setDeletingId(null);
  };

  const locale = displayLocale();
  const review = load.status === "ready" ? load.review : null;
  const peakDay = Math.max(1, ...(review?.days.map((day) => day.count) ?? [1]));
  const peakHour = Math.max(1, ...(review?.hours ?? [1]));

  return (
    <section className={styles.panel} aria-label="Watch history">
      <div className={styles.head}>
        <h2>Watch history</h2>
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          Import Takeout
        </Button>
      </div>
      {load.status === "loading" ? <p className={styles.quiet}>Loading watch history…</p> : null}
      {load.status === "failed" ? (
        <p aria-live="polite" className={styles.error}>
          Watch history could not be read.{" "}
          <Button size="sm" variant="ghost" onClick={() => void refresh()}>
            Try again
          </Button>
        </p>
      ) : null}
      {review && !review.hasData ? (
        <p className={styles.quiet}>
          Nothing imported yet. Request your data at takeout.google.com: choose only YouTube and YouTube Music, then
          History, and set the format to JSON. Import the zip, or the watch-history.json inside it, here.
        </p>
      ) : null}
      {review?.hasData ? (
        <>
          <p className={styles.figure}>
            {review.total} {review.total === 1 ? "video" : "videos"} watched, {shortDate(review.from, locale)} to{" "}
            {shortDate(review.to, locale)}.
          </p>
          <ul className={styles.bars} aria-label="Videos watched per day">
            {review.days.map((day) => (
              <li key={day.date} title={`${shortDate(day.date, locale)}: ${day.count}`}>
                <span className="visually-hidden">{`${shortDate(day.date, locale)}: ${day.count}`}</span>
                <span
                  className={styles.bar}
                  data-empty={day.count === 0}
                  style={{ height: `${day.count === 0 ? 4 : Math.max(8, (day.count / peakDay) * 100)}%` }}
                />
              </li>
            ))}
          </ul>
          <div className={styles.axis} aria-hidden="true">
            <span>{shortDate(review.from, locale)}</span>
            <span>{shortDate(review.to, locale)}</span>
          </div>
          <p className={styles.subhead}>By hour of day ({review.timezone})</p>
          <ul className={styles.bars} aria-label="Videos watched per hour of the day">
            {review.hours.map((count, hour) => (
              <li key={hour} title={`${hourLabel(hour)}: ${count}`}>
                <span className="visually-hidden">{`${hourLabel(hour)}: ${count}`}</span>
                <span
                  className={styles.bar}
                  data-empty={count === 0}
                  style={{ height: `${count === 0 ? 4 : Math.max(8, (count / peakHour) * 100)}%` }}
                />
              </li>
            ))}
          </ul>
          <div className={styles.axis} aria-hidden="true">
            <span>00</span>
            <span>12</span>
            <span>23</span>
          </div>
          {review.estimate.videos > 0 ? (
            <>
              <p className={styles.figure}>{estimateLine(review.estimate)}</p>
              <p className={styles.caveat}>{estimateCaveat(review.lengths.known)}</p>
            </>
          ) : (
            <p className={styles.quiet}>{emptyWindowLine(review.watchesHeld, review.days.length)}</p>
          )}
          {lengthsLine(review.lengths) ? (
            <p className={styles.caveat}>
              {lengthsLine(review.lengths)}{" "}
              {review.lengths.keyState !== "set" && review.lengths.missing > 0 ? (
                <Link href="/settings/passwords-and-keys">Passwords and keys</Link>
              ) : null}
            </p>
          ) : null}
          {review.lengths.keyState === "set" && review.lengths.missing > 0 ? (
            <Button size="sm" variant="ghost" disabled={fetchingLengths} onClick={() => void runLengths()}>
              {fetchingLengths ? "Fetching video lengths…" : "Fetch video lengths"}
            </Button>
          ) : null}
          {review.excluded.ads + review.excluded.posts + review.excluded.music > 0 ? (
            <p className={styles.caveat}>
              Not counted: {review.excluded.ads} ads, {review.excluded.posts} posts, {review.excluded.music} YouTube
              Music plays.
            </p>
          ) : null}
          {review.imports.length ? (
            <ul className={styles.imports} aria-label="Imports">
              {review.imports.map((item) => (
                <li key={item.id}>
                  <span>
                    {item.filename}, {item.eventCount} entries
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Delete import ${item.filename}`}
                    disabled={deletingId !== null}
                    onClick={() => void remove(item.id)}
                  >
                    Delete this import
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {/* A live region present from the first render, so a later message is announced. It carries no `status` role: Review's other toasts own that role, and a second one would be ambiguous to a reader and a test. */}
      <div aria-live="polite" aria-atomic="true" data-watch-status className={styles.quiet}>
        {[message, lengthsMessage].filter(Boolean).join(" ")}
      </div>
      <Sheet open={open} onClose={close} title="Import watch history">
        <div className={styles.sheet}>
          <ol className={styles.steps}>
            <li>Go to takeout.google.com and choose only YouTube and YouTube Music.</li>
            <li>Under All YouTube data included, select History, and set the format to JSON.</li>
            <li>Export, download the zip, and choose it (or its watch-history.json) below.</li>
          </ol>
          <p className={styles.quiet}>
            The file is read in this browser and sent to your own server. Importing the same file twice adds nothing.
            Shorts look the same as other videos in the export. Files up to 50 MB are accepted (and the history inside a
            zip must unpack to under 50 MB); if yours is larger, export a shorter date range.
          </p>
          <input
            type="file"
            accept=".json,.zip,application/json,application/zip"
            aria-label="Takeout file"
            disabled={busy}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setProblem("");
            }}
          />
          {problem ? (
            <p role="alert" className={styles.error}>
              {problem}
            </p>
          ) : null}
          <Button variant="primary" disabled={!file || busy} onClick={() => void upload()}>
            {busy ? "Importing…" : "Import"}
          </Button>
        </div>
      </Sheet>
    </section>
  );
}
