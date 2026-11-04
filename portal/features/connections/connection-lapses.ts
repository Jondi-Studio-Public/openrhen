"use client";

import { calendarSourceConnections, primarySourceConnection } from "@openrhen/contracts";
import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { useEffect, useSyncExternalStore } from "react";

/**
 * Lapsed connections, worked out from the last run each sync route recorded. Never a live proof or probe:
 * a proof signs in to the roster provider, and a sign-in that is checked on every page open risks locking the account.
 */
export interface LapsedConnection {
  /** A calendar source's connection id; any other id renders with the title it is given. */
  id: string;
  title: string;
  /** What the welcome-back row says. */
  label: string;
}

export interface ConnectionLapses {
  lapsed: LapsedConnection[];
  /** When the roster last synced for real, or null when no good run is recorded. */
  rosterSyncedAt: string | null;
  /** Every run on record failed and the oldest is as old as the retention window: the last good one was pruned. */
  rosterHistoryDays: number | null;
  /** False until the first read has answered. */
  ready: boolean;
}

export interface RecordedRead {
  enabled?: boolean;
  lastRun: { status: string; summary?: { reason?: string } | null } | null;
  lastSuccessAt?: string | null;
  oldestRunAt?: string | null;
}

/**
 * The calendar sources whose last run is read: the primary (roster) source first, titled "<label> roster", then the
 * others, the latest registered first, titled by their label. Registry labels, so a build with other sources reads
 * them without this file naming one.
 */
function lapseSources(): { id: string; title: string; url: string }[] {
  const manifests = calendarSourceConnections();
  const primary = manifests.filter((manifest) => manifest.calendarSource?.role === "primary");
  const rest = manifests.filter((manifest) => manifest.calendarSource?.role !== "primary").reverse();
  return [...primary, ...rest].map((manifest) => ({
    id: manifest.id,
    title: manifest.calendarSource?.role === "primary" ? `${manifest.label} roster` : manifest.label,
    url: `/api/connections/${manifest.id}/sync`
  }));
}

const NONE: ConnectionLapses = { lapsed: [], rosterSyncedAt: null, rosterHistoryDays: null, ready: false };

function sinceDate(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? ""
    : dateTimeFormat(displayLocale(), { day: "numeric", month: "short" }).format(at);
}

/** A connection has lapsed when its last recorded run failed. A switched-off or unconfigured one has not lapsed. */
export function deriveLapses(
  reads: Partial<Record<LapsedConnection["id"], RecordedRead | undefined>>
): ConnectionLapses {
  const lapsed: LapsedConnection[] = [];
  // A roster that is switched off, unconfigured or never run has no sync to be late; only a real outcome counts.
  const rosterRead = reads[primarySourceConnection()?.id ?? ""];
  const rosterStatus = rosterRead?.lastRun?.status;
  const rosterKnown = rosterStatus === "synced" || rosterStatus === "needs_review" || rosterStatus === "failed";
  for (const source of lapseSources()) {
    const read = reads[source.id];
    if (!read || read.enabled === false || read.lastRun?.status !== "failed") continue;
    // Says what is true of the roster, not why: a failed run does not prove the sign-in is what lapsed.
    const since = read.lastSuccessAt ? sinceDate(read.lastSuccessAt) : "";
    lapsed.push({
      id: source.id,
      title: source.title,
      label: since ? `${source.title} hasn't synced since ${since}` : `${source.title} hasn't synced lately`
    });
  }
  const rosterSyncedAt = rosterKnown ? (rosterRead?.lastSuccessAt ?? null) : null;
  // The server prunes runs after this many days, so failures all the way back leave no success row to date.
  const oldest = rosterRead?.oldestRunAt ? Date.parse(rosterRead.oldestRunAt) : Number.NaN;
  // Said as the age of the oldest run still held, so the wording follows the server's real cutoff.
  const ended =
    rosterStatus === "failed" && rosterSyncedAt === null && Date.now() - oldest >= (RUN_RETENTION_DAYS - 5) * DAY_MS;
  const rosterHistoryDays = ended ? Math.floor((Date.now() - oldest) / DAY_MS) : null;
  return { lapsed, rosterSyncedAt, rosterHistoryDays, ready: true };
}

const DAY_MS = 86_400_000;
/** How long the server keeps sync run rows: `RUN_RETENTION_DAYS` in the roster sync, which a page cannot import. */
const RUN_RETENTION_DAYS = 90;

/** "Roster last synced 9 days ago" once the last good sync is more than two days old, else null. */
export function rosterStaleLine(
  rosterSyncedAt: string | null,
  now: Date,
  historyDays: number | null = null
): string | null {
  if (!rosterSyncedAt) return historyDays === null ? null : `Roster hasn't synced in over ${historyDays} days`;
  const at = Date.parse(rosterSyncedAt);
  if (Number.isNaN(at)) return null;
  const elapsed = now.getTime() - at;
  return elapsed > 2 * DAY_MS ? `Roster last synced ${Math.floor(elapsed / DAY_MS)} days ago` : null;
}

async function readRecorded(url: string): Promise<RecordedRead | undefined> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return undefined;
    const body = (await response.json()) as Partial<RecordedRead> | null;
    return {
      ...(typeof body?.enabled === "boolean" ? { enabled: body.enabled } : {}),
      lastRun: body?.lastRun ?? null,
      lastSuccessAt: body?.lastSuccessAt ?? null,
      oldestRunAt: body?.oldestRunAt ?? null
    };
  } catch {
    return undefined;
  }
}

/** Reads go stale after five minutes; a page left open refreshes on that beat and when the tab is looked at. */
export const LAPSES_REFRESH_MS = 5 * 60_000;
/** A read with a failed provider is tried again sooner. */
export const LAPSES_RETRY_MS = 60_000;

/**
 * One shared store for every consumer (tab bar, rail, welcome-back, Day). The app shell stays mounted across
 * navigation, so a read taken once on mount would never see a sync that fails or recovers later.
 */
let current: ConnectionLapses = NONE;
/** When the last read stops being trusted: five minutes after it completed, one if part of it failed. 0 = now. */
let expiresAt = 0;
let inflight: Promise<void> | null = null;
/** A sync command landed while a read was in flight: that read may predate it, so read again right after. */
let dirty = false;
let timer: number | null = null;
let lastReads: Partial<Record<LapsedConnection["id"], RecordedRead>> = {};
const subscribers = new Set<() => void>();

async function readOnce(): Promise<void> {
  const answers = await Promise.all(lapseSources().map((source) => readRecorded(source.url)));
  // A read that failed keeps that provider's previous record: not hearing back is not good news.
  const next = { ...lastReads };
  let complete = true;
  lapseSources().forEach((source, index) => {
    const answer = answers[index];
    if (answer) next[source.id] = answer;
    else complete = false;
  });
  lastReads = next;
  current = deriveLapses(next);
  expiresAt = Date.now() + (complete ? LAPSES_REFRESH_MS : LAPSES_RETRY_MS);
  for (const notify of subscribers) notify();
}

function refresh(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      do {
        dirty = false;
        await readOnce();
      } while (dirty);
    } finally {
      inflight = null;
      schedule();
    }
  })();
  return inflight;
}

/** The next refresh is timed from when the read expires, not from a fixed beat that request latency can miss. */
function schedule() {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  if (subscribers.size === 0 || inflight) return;
  timer = window.setTimeout(refreshIfStale, Math.max(0, expiresAt - Date.now()));
}

function refreshIfStale() {
  if (Date.now() >= expiresAt) void refresh();
  else schedule();
}

/** Read again now: call after a sync command, whose run is the newest record. */
export function invalidateConnectionLapses() {
  expiresAt = 0;
  if (inflight) dirty = true;
  else if (subscribers.size > 0) void refresh();
}

/** Test seam: forget everything. */
export function resetConnectionLapses() {
  current = NONE;
  lastReads = {};
  expiresAt = 0;
  inflight = null;
  dirty = false;
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  subscribers.clear();
}

function subscribe(notify: () => void) {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0 && timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };
}

export function useConnectionLapses(): ConnectionLapses {
  useEffect(() => {
    refreshIfStale();
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshIfStale();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => NONE
  );
}
