"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { GoogleCalendarProofResult } from "@openrhen/contracts";
import { formatConnectionDateTime as formatDateTime } from "@/shared/connection-date-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DetailCode, DetailDivider, DetailStack, DetailSubheading } from "@/components/connection-detail";
import { CalendarSyncRow } from "./calendar-sync-row";

interface CalendarChoice {
  calendarId: string;
  summary: string;
  primary?: boolean;
  accessRole?: string;
  timezone?: string;
  selected: boolean;
}

type Proof = GoogleCalendarProofResult | { status: "loading" };

type Choices =
  | { state: "loading" }
  | {
      state: "ready";
      calendars: CalendarChoice[];
      saved: CalendarChoice[];
      error: string | null;
      /** Google Calendar is not set up, so the list is only what was saved earlier; not an error. */
      notSetUp?: boolean;
    }
  | { state: "failed"; message: string };

const failureHints: Record<string, string> = {
  invalid_grant:
    "Google refused the saved sign-in. Run the one-time Google Calendar sign-in again and update the refresh token on the proxy."
};

/**
 * Google Calendar, read only: whether the proxy holds a working sign-in (never the token), the last
 * sync and a "Sync now", and which of the account's calendars the sync reads. Shared, holiday and
 * subscribed calendars stay unticked until chosen. See the calendar sync design note.
 */
export function GoogleCalendarCard({
  children,
  onChecked
}: {
  children?: ReactNode;
  /** Called after the connection check or a sync settles, so a summary of the same state can reload. */
  onChecked?: () => void;
}) {
  const [proof, setProof] = useState<Proof>({ status: "loading" });
  const [testing, setTesting] = useState(false);
  const [choices, setChoices] = useState<Choices>({ state: "loading" });
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const check = useCallback(async () => {
    setTesting(true);
    setProof({ status: "loading" });
    try {
      // A failed proof answers 502 with the result in the body, so the status code is not the signal.
      const response = await fetch("/api/connections/google_calendar/proof", { cache: "no-store" });
      const body = (await response.json()) as GoogleCalendarProofResult;
      if (!body || typeof body.status !== "string") throw new Error("unexpected proof response");
      setProof(body);
    } catch {
      setProof({
        status: "failed",
        checkedAt: new Date().toISOString(),
        message: "The portal could not reach the Google Calendar proof endpoint."
      });
    } finally {
      setTesting(false);
      onChecked?.();
    }
  }, [onChecked]);

  const loadCalendars = useCallback(async () => {
    try {
      const response = await fetch("/api/connections/google_calendar/calendars", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as {
        calendars?: CalendarChoice[];
        error?: string;
        reason?: string;
        notConfigured?: boolean;
      } | null;
      if (!response.ok && !body?.calendars) {
        setChoices({ state: "failed", message: body?.error ?? "Calendars could not be loaded." });
        return;
      }
      const calendars = body?.calendars ?? [];
      setChoices({
        state: "ready",
        calendars,
        saved: calendars,
        error: response.ok ? null : (body?.error ?? "Google could not list the calendars."),
        notSetUp: body?.notConfigured === true
      });
    } catch {
      setChoices({ state: "failed", message: "The portal could not reach the calendars endpoint." });
    }
  }, []);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- sets state only after the awaited request settles
    void check();
    void loadCalendars();
  }, [check, loadCalendars]);

  const toggle = (calendarId: string) => {
    setSaveMessage(null);
    setChoices((current) =>
      current.state === "ready"
        ? {
            ...current,
            calendars: current.calendars.map((calendar) =>
              calendar.calendarId === calendarId ? { ...calendar, selected: !calendar.selected } : calendar
            )
          }
        : current
    );
  };

  const dirty =
    choices.state === "ready" &&
    choices.calendars.some((calendar, index) => calendar.selected !== choices.saved[index]?.selected);

  const save = async () => {
    if (choices.state !== "ready") return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const response = await fetch("/api/connections/google_calendar/calendars", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          calendars: choices.calendars.map(({ calendarId, summary, selected }) => ({ calendarId, summary, selected }))
        }),
        cache: "no-store"
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setSaveMessage(body?.error ?? "The calendar choice could not be saved.");
        return;
      }
      setChoices({ ...choices, saved: choices.calendars });
      const count = choices.calendars.filter((calendar) => calendar.selected).length;
      setSaveMessage(
        count === 0
          ? "Saved. No calendars are ticked, so the sync reads nothing."
          : `Saved. The sync reads ${count} calendar${count === 1 ? "" : "s"}.`
      );
    } catch {
      setSaveMessage("The portal could not reach the calendars endpoint.");
    } finally {
      setSaving(false);
    }
  };

  const notSetUp = proof.status === "not_configured";
  const selectedCount = choices.state === "ready" ? choices.calendars.filter((c) => c.selected).length : 0;

  return (
    <DetailStack>
      <DetailSubheading title="Connection">
        <Button size="sm" disabled={testing} onClick={() => void check()}>
          {testing ? "Checking…" : "Test again"}
        </Button>
      </DetailSubheading>
      <p className="microcopy">Read only. The sign-in lives on the outbound proxy, never in the portal.</p>
      {proof.status === "loading" && <p className="empty">Checking the connection…</p>}
      {proof.status === "not_configured" && (
        <>
          <div>
            <Badge tone="warn">Needs a setting on the server</Badge>
          </div>
          <p>Add the missing settings to the proxy, then return here to test.</p>
          <DetailCode>{proof.missing.join(", ")}</DetailCode>
        </>
      )}
      {proof.status === "failed" && (
        <>
          <div>
            <Badge tone="danger">Could not connect</Badge>
          </div>
          <p>{proof.message}</p>
          {proof.reason && failureHints[proof.reason] && <p className="microcopy">{failureHints[proof.reason]}</p>}
          <p className="microcopy">Nothing on Google or in your plan was changed.</p>
        </>
      )}
      {proof.status === "connected" && (
        <>
          <div>
            <Badge tone="accent">Connected</Badge>
          </div>
          <p className="microcopy">
            Checked {formatDateTime(proof.checkedAt)}. Google lists {proof.calendarCount} calendar
            {proof.calendarCount === 1 ? "" : "s"} on this account.
          </p>
        </>
      )}

      <DetailDivider />
      <CalendarSyncRow provider="google_calendar" notSetUp={notSetUp} {...(onChecked ? { onSynced: onChecked } : {})} />

      <DetailDivider />
      <DetailSubheading title="Calendars to read">
        <Button size="sm" disabled={saving || !dirty} onClick={() => void save()}>
          {saving ? "Saving…" : "Save choice"}
        </Button>
      </DetailSubheading>
      {choices.state === "loading" && <p className="empty">Loading the calendar list…</p>}
      {choices.state === "failed" && <p>{choices.message}</p>}
      {choices.state === "ready" && (
        <>
          {choices.error && <p className="microcopy">{choices.error} Showing the calendars saved earlier.</p>}
          {choices.calendars.length === 0 ? (
            <p className="empty">
              {choices.notSetUp
                ? "Not set up yet, so there are no calendars to choose from."
                : "No calendars to choose from."}
            </p>
          ) : (
            <fieldset className="field">
              <legend className="microcopy">
                Only ticked calendars are read. Holiday, shared and subscribed calendars start unticked.
              </legend>
              {choices.calendars.map((calendar) => (
                <label className="checkbox-row" key={calendar.calendarId}>
                  <input type="checkbox" checked={calendar.selected} onChange={() => toggle(calendar.calendarId)} />
                  <span>
                    {calendar.summary}
                    {calendar.primary ? " (primary)" : ""}
                    {calendar.accessRole && calendar.accessRole !== "owner" ? ` · ${calendar.accessRole}` : ""}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {choices.calendars.length > 0 && (
            <p className="microcopy">
              {selectedCount} of {choices.calendars.length} ticked.
            </p>
          )}
        </>
      )}
      {saveMessage && <p className="microcopy">{saveMessage}</p>}
      {children && (
        <>
          <DetailDivider />
          {children}
        </>
      )}
    </DetailStack>
  );
}
