"use client";

import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { PARTS_LOCALE } from "@openrhen/contracts";
import { useEffect, useState } from "react";
import { usePortal } from "@/state/portal-provider";
import { connectionExtensions, withExtensionRows } from "./connection-extensions";
import { type ConnectionInputs, type ProviderStatusView } from "./use-connection-data";

/** "unknown": nothing recorded yet, and the page showing it does not check live (the You overview). */
export type ConnectionState = "on" | "setup" | "off" | "behind" | "checking" | "unknown";

export interface ConnectionSummary {
  /** Stable, and the hash the details sheet opens from: /connections#google-calendar. */
  id: string;
  title: string;
  state: ConnectionState;
  /** One line under the title; never an environment variable name. */
  meta: string;
  /**
   * An integration the app works without (everything but the Planner). While nothing is configured it reads "Not
   * connected (optional)": a choice not yet made, not a problem to fix.
   */
  optional?: boolean;
}

export const CONNECTION_IDS = ["planner", "google-calendar", "openai", "google-maps"] as const;

export const NEEDS_SETTING = "Needs a setting on the server";

export const NOT_CONNECTED_OPTIONAL = "Not connected (optional)";

/** Rows other than the Planner that sit in "setup" are optional integrations nobody has configured. */
function markOptional(summary: ConnectionSummary): ConnectionSummary {
  if (summary.id === "planner" || summary.state !== "setup") return summary;
  return { ...summary, optional: true, meta: NOT_CONNECTED_OPTIONAL };
}

const SPACES = /[\s  ]+/g;

/** "8:33 am" for a moment today in the person's time zone, "15 Nov" for any other day. */
export function connectionWhen(iso: string, timeZone: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const day = (date: Date) => dateTimeFormat(PARTS_LOCALE, { dateStyle: "short", timeZone }).format(date);
  if (day(at) === day(now)) {
    return dateTimeFormat(displayLocale(), { hour: "numeric", minute: "2-digit", timeZone })
      .format(at)
      .replace(SPACES, " ")
      .toLowerCase();
  }
  return dateTimeFormat(displayLocale(), { day: "numeric", month: "short", timeZone }).format(at);
}

function providerSummary(
  id: string,
  title: string,
  status: ProviderStatusView | undefined,
  when: (iso: string) => string
): ConnectionSummary {
  if (!status) return { id, title, state: "checking", meta: "Checking" };
  if (status.source === "not_configured") return { id, title, state: "setup", meta: NEEDS_SETTING };
  // Google only: nothing needed refreshing, so no request was made and reachability is unknown, not failed.
  if (status.source === "skipped") return { id, title, state: "on", meta: "Nothing to refresh lately" };
  if (status.reachable === null) return { id, title, state: "checking", meta: "Checking" };
  if (status.reachable === false) return { id, title, state: "off", meta: "Not answering" };
  const at = status.lastCallAt ?? status.checkedAt;
  return { id, title, state: "on", meta: at ? `Checked ${when(at)}` : "Answering" };
}

/**
 * The connection rows, worked out from what the reads returned. The Connections page and the
 * You overview both call this, so the two cannot disagree.
 *
 * on: working. setup: needs a setting on the server before it can work. off: not working, or switched
 * off on the server. checking: the first answer has not come back yet.
 */
export function deriveConnectionSummaries(inputs: ConnectionInputs, now: Date = new Date()): ConnectionSummary[] {
  const when = (iso: string) => connectionWhen(iso, inputs.timezone, now);
  return withExtensionRows(
    [
      plannerSummary(inputs, when),
      googleCalendarSummary(inputs, when),
      providerSummary("openai", "OpenAI", inputs.providers.openai, when),
      providerSummary("google-maps", "Google Maps", inputs.providers.google, when)
    ].map(markOptional),
    (extension) => markOptional(extension.summary(inputs.extensions[extension.id], when, now))
  );
}

function plannerSummary(inputs: ConnectionInputs, when: (iso: string) => string): ConnectionSummary {
  const base = { id: "planner", title: "Planner" };
  const { probe, planning } = inputs;
  if (!inputs.ready || probe.state === "loading") return { ...base, state: "checking", meta: "Checking" };
  if (probe.state === "unreachable")
    return probe.configured
      ? { ...base, state: "off", meta: "Not answering" }
      : { ...base, state: "setup", meta: NEEDS_SETTING };
  if (planning?.status === "failed") return { ...base, state: "off", meta: "The last recalculation failed" };
  if (planning?.status === "stale") return { ...base, state: "off", meta: "Recalculation is overdue" };
  if (planning?.status === "pending") return { ...base, state: "on", meta: "Recalculating" };
  const at = planning?.lastSuccessfulAt ?? planning?.result?.calculatedAt;
  return { ...base, state: "on", meta: at ? `Recalculated ${when(at)}` : "No plan calculated yet" };
}

function googleCalendarSummary(inputs: ConnectionInputs, when: (iso: string) => string): ConnectionSummary {
  const base = { id: "google-calendar", title: "Google Calendar" };
  const { googleProof: proof, googleSync: sync } = inputs;
  if (proof.status === "loading") return { ...base, state: "checking", meta: "Checking" };
  if (proof.status === "not_configured") return { ...base, state: "setup", meta: NEEDS_SETTING };
  if (proof.status === "failed") return { ...base, state: "off", meta: "Could not connect" };
  if (sync.state === "off") return { ...base, state: "setup", meta: "Sync is off on the server" };
  if (sync.state === "loaded") {
    if (sync.run.status === "failed") return { ...base, state: "off", meta: "The last sync failed" };
    return { ...base, state: "on", meta: `Synced ${when(sync.run.finishedAt ?? sync.run.startedAt)}` };
  }
  if (sync.state === "loading") return { ...base, state: "on", meta: "Connected" };
  return { ...base, state: "on", meta: "Connected, no sync yet" };
}

const PROBLEM_PHRASE: Partial<Record<ConnectionState, string>> = {
  setup: "needs a setting on the server",
  off: "is not working",
  behind: "is behind"
};

/** The one sentence under the page title. Optional connections nobody has set up are never a problem. */
export function connectionsAnswer(summaries: readonly ConnectionSummary[]): string {
  if (summaries.length === 0) return "Checking your connections.";
  const problems = summaries.filter(
    (s) => !s.optional && (s.state === "setup" || s.state === "off" || s.state === "behind")
  );
  // A row with nothing recorded is not known to work, so it never counts towards "everything".
  const allKnown = !summaries.some((s) => s.state === "unknown");
  const unconfigured = summaries.some((s) => s.optional);
  if (problems.length === 0) {
    if (summaries.some((s) => s.state === "checking")) return "Checking your connections.";
    if (unconfigured) {
      const others = summaries.filter((s) => !s.optional);
      const nothingElse = others.every((s) => s.id === "planner" && (s.state === "on" || s.state === "unknown"));
      return nothingElse
        ? "Nothing is connected yet; all of these are optional."
        : "Everything you have connected is working.";
    }
    return allKnown ? "Everything is connected." : "No connection has reported a problem.";
  }
  const only = problems[0];
  if (problems.length === 1 && only)
    return allKnown && !unconfigured
      ? `Everything is connected except ${only.title}, which ${PROBLEM_PHRASE[only.state]}.`
      : `${only.title} ${PROBLEM_PHRASE[only.state]}.`;
  const names = problems.map((p) => p.title);
  const list = `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${problems.length} of ${summaries.length} connections need attention: ${list}.`;
}

/** A sync or ingest run as its GET route records it. */
export interface RecordedRun {
  startedAt: string;
  finishedAt: string | null;
  status: string;
}

/**
 * What the recorded-only rows read: the last runs the worker and sync routes wrote, never a proof or
 * probe. `undefined` while a read is in flight; `enabled` is the server's own sync switch.
 */
export interface RecordedConnectionInputs {
  ready: boolean;
  timezone: string;
  planning: ConnectionInputs["planning"];
  googleCalendar: { enabled?: boolean; lastRun: RecordedRun | null } | undefined;
  /** Each registered connection extension's recorded run, by id (`connection-extensions.ts`). */
  extensions: Record<string, { enabled?: boolean; lastRun: RecordedRun | null } | undefined>;
}

function recordedRunSummary(
  base: { id: string; title: string },
  read: { enabled?: boolean; lastRun: RecordedRun | null } | undefined,
  when: (iso: string) => string,
  synced: string
): ConnectionSummary {
  if (!read) return { ...base, state: "checking", meta: "Checking" };
  if (read.enabled === false) return { ...base, state: "setup", meta: "Sync is off on the server" };
  const run = read.lastRun;
  if (!run) return { ...base, state: "unknown", meta: "Nothing recorded yet" };
  const at = when(run.finishedAt ?? run.startedAt);
  if (run.status === "failed") return { ...base, state: "off", meta: `The last run failed, ${at}` };
  if (run.status === "not_configured") return { ...base, state: "setup", meta: NEEDS_SETTING };
  return { ...base, state: "on", meta: `${synced} ${at}` };
}

/**
 * The rows the You overview shows, from recorded state only: the plan's own status and each
 * connection's last run. Nothing here signs in to an upstream, runs a proof or probes a provider, so a hub
 * page opened all day costs nothing outside the server; the live checks stay on Connections.
 */
export function deriveRecordedSummaries(inputs: RecordedConnectionInputs, now: Date = new Date()): ConnectionSummary[] {
  const when = (iso: string) => connectionWhen(iso, inputs.timezone, now);
  const planner: ConnectionSummary = (() => {
    const base = { id: "planner", title: "Planner" };
    const planning = inputs.planning;
    if (!inputs.ready) return { ...base, state: "checking", meta: "Checking" };
    if (planning?.status === "failed") return { ...base, state: "off", meta: "The last recalculation failed" };
    if (planning?.status === "stale") return { ...base, state: "off", meta: "Recalculation is overdue" };
    if (planning?.status === "pending") return { ...base, state: "on", meta: "Recalculating" };
    const at = planning?.lastSuccessfulAt ?? planning?.result?.calculatedAt;
    return at
      ? { ...base, state: "on", meta: `Recalculated ${when(at)}` }
      : { ...base, state: "unknown", meta: "No plan calculated yet" };
  })();
  return withExtensionRows(
    [
      planner,
      markOptional(
        recordedRunSummary({ id: "google-calendar", title: "Google Calendar" }, inputs.googleCalendar, when, "Synced")
      )
    ],
    (extension) =>
      markOptional(
        recordedRunSummary(
          { id: extension.id, title: extension.title },
          inputs.extensions[extension.id],
          when,
          extension.recorded?.synced ?? "Synced"
        )
      ),
    (extension) => extension.recorded !== undefined
  );
}

type RecordedRead = { enabled?: boolean; lastRun: RecordedRun | null };

async function readRecorded(url: string): Promise<RecordedRead | undefined> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return undefined;
    const body = (await response.json()) as Partial<RecordedRead>;
    return { ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}), lastRun: body.lastRun ?? null };
  } catch {
    return undefined;
  }
}

/** {@link deriveRecordedSummaries} for a page: the GETs of recorded runs plus the portal state. */
export function useRecordedConnectionSummaries(): ConnectionSummary[] {
  const { state, ready } = usePortal();
  const [reads, setReads] = useState<Pick<RecordedConnectionInputs, "googleCalendar">>({
    googleCalendar: undefined
  });
  const [extensionReads, setExtensionReads] = useState<RecordedConnectionInputs["extensions"]>({});
  useEffect(() => {
    let live = true;
    const sources = {
      googleCalendar: "/api/connections/google_calendar/sync"
    } as const;
    for (const [key, url] of Object.entries(sources) as [keyof typeof sources, string][])
      void readRecorded(url).then((read) => {
        // A failed read reads as "nothing recorded" rather than spinning forever.
        if (live) setReads((previous) => ({ ...previous, [key]: read ?? { lastRun: null } }));
      });
    for (const extension of connectionExtensions())
      if (extension.recorded)
        void readRecorded(extension.recorded.url).then((read) => {
          if (live) setExtensionReads((previous) => ({ ...previous, [extension.id]: read ?? { lastRun: null } }));
        });
    return () => {
      live = false;
    };
  }, []);
  return deriveRecordedSummaries({
    ready,
    timezone: state.settings.timezone,
    planning: state.planning,
    ...reads,
    extensions: extensionReads
  });
}
