"use client";

import { dateTimeFormat, displayLocale } from "@/shared/locale";
import Link from "next/link";
import { primarySourceConnection } from "@openrhen/contracts";
import { useDraftId } from "@/components/form-actions";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { usePortal } from "@/state/portal-provider";
import { useNow } from "@/shared/clock";
import { buildDayPlan, type DayPlanItem, type DayPlanUntimed, type DayPlanWait } from "@/features/today/day-plan";
import { dayAnswer, durationLabel } from "@/features/today/day-summary";
import { nextDayKey, zonedDayBounds } from "@/features/today/local-datetime";
import { dayCapacityMinutes, localDayKey, overlaps } from "@/features/today/today-view";
import { tomorrowBrief } from "@/features/today/tomorrow-preview";
import {
  commitmentEditorIsBlank,
  emptyCommitmentEditor,
  type CommitmentEditorDraft
} from "@/features/today/today-drafts";
import {
  createContact,
  createOneOffPlace,
  findCommitmentMatch,
  saveCommitmentDraft,
  type HandEntryMatch
} from "@/features/today/commitment-save";
import { dailyPlanCommand, routineStepStatusCommand } from "@/features/today/today-commands";
import { isOpenEndedDisruption } from "@/features/disruptions/disruption-commands";
import { activeDisruption } from "@/features/disruptions/disruption-summary";
import { CommitmentEditor } from "@/features/today/components/commitment-editor";
import { DayPlanDetailSheet } from "@/features/today/components/day-plan-detail-sheet";
import { DayPlanCard } from "@/features/today/components/day-plan-card";
import { DirectionPanel } from "@/features/today/components/direction-panel";
import { OccurrencePanel } from "@/features/today/components/occurrence-panel";
import { PlanChangePanel } from "@/features/today/components/plan-change-panel";
import { SessionActivityPanel } from "@/features/today/components/session-activity-panel";
import { SleepPlanEditor } from "@/features/today/components/sleep-plan-editor";
import { rosterStaleLine, useConnectionLapses } from "@/features/connections/connection-lapses";
import { Sheet } from "@/components/sheet";
import { ChevronIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { IconButton } from "@/components/ui/icon-button";
import { List, ListRow } from "@/components/ui/list-row";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceTabs } from "@/components/place-tabs";
import { Meter, Stat } from "@/components/ui/stat";
import { Switch } from "@/components/ui/switch";
import { formatZonedTime } from "@/shared/date-format";
import { navigateTo } from "@/shared/navigate";
import { useMediaQuery } from "@/shared/use-media-query";
import styles from "./day.module.css";

/** The sheets the side rows open. Each is also a link target, so other pages can land on one open. */
type DaySheet = "direction" | "shape" | "sleep" | "sessions" | "occurrences";

/**
 * Where a link from elsewhere may land: the hash or the shorter `?open=` name opens the sheet that
 * holds the control, because a link that arrives on a summary the reader still has to open has failed.
 */
const DEEP_LINKS: Record<string, DaySheet> = {
  direction: "direction",
  sleep: "sleep",
  "today-sleep": "sleep",
  sessions: "sessions",
  "today-sessions": "sessions",
  occurrences: "occurrences",
  "today-occurrences": "occurrences"
};

const SHEET_TITLES: Record<DaySheet, string> = {
  direction: "Direction for today",
  shape: "Change the day",
  sleep: "Sleep plan",
  sessions: "Recorded today",
  occurrences: "Recurring windows"
};

/** How far ahead the day can be paged: the week the strip shows, today included. */
const DAYS_AHEAD = 6;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export default function TodayPage() {
  const {
    state,
    ready,
    saveEntityCommand,
    snoozeAction,
    saveCommitmentRecurrenceRuleCommand,
    slots,
    allocations,
    recommendation,
    currentDirective,
    upcomingDirectives,
    dayPlan: engineDayPlan,
    forecasts,
    capacityEnvelopes
  } = usePortal();
  const detailedEndsAt = capacityEnvelopes?.find((envelope) => envelope.kind === "detailed")?.endsAt ?? null;
  // Nothing here shows seconds: the now-line, the day keys and the free time all move by the minute.
  const now = useNow("minute");
  // Recorded sync state only; never a live the roster provider proof.
  const lapses = useConnectionLapses();
  const rosterLine = rosterStaleLine(lapses.rosterSyncedAt, now, lapses.rosterHistoryDays);
  const timezone = state.settings.timezone;
  const todayKey = localDayKey(now, timezone);
  const desk = useMediaQuery("(min-width: 1024px)");
  const phone = !desk;
  /** Which day is on the page, as days after today. Zero is today, and only today has a now. */
  // Held against the day it was chosen on, so a page left open past midnight comes back to the new
  // today rather than quietly showing the day after the one it said.
  const [paged, setPaged] = useState({ from: todayKey, offset: 0 });
  // A link from the week (`?day=2026-08-21`) names the day itself, not an offset, and is matched
  // against today at render: the clock is not at today yet on the first paint, so an offset worked
  // out then would be wrong. Paging by hand drops it.
  const [linkedDay, setLinkedDay] = useState<string | null>(null);
  const linkedOffset = linkedDay
    ? Array.from({ length: DAYS_AHEAD + 1 }, (_, index) => index).find(
        (index) => nextDayKey(todayKey, index) === linkedDay
      )
    : undefined;
  const offset = linkedOffset ?? (paged.from === todayKey ? paged.offset : 0);
  const setOffset = (next: number) => {
    setLinkedDay(null);
    setPaged({ from: todayKey, offset: Math.max(0, Math.min(DAYS_AHEAD, next)) });
  };
  const dayKey = nextDayKey(todayKey, offset);
  const [sheet, setSheet] = useState<DaySheet | null>(null);
  const [showReserved, setShowReserved] = useState(false);
  const draftId = useDraftId();
  const [handEntryMatch, setHandEntryMatch] = useState<HandEntryMatch | null>(null);
  const [commitmentDraft, setCommitmentDraft] = useState<CommitmentEditorDraft>(() =>
    emptyCommitmentEditor(state.settings)
  );
  const [error, setError] = useState("");
  const [desiredWins, setDesiredWins] = useState<string[]>(state.dailyPlan?.desiredActionIds ?? []);
  const [deferredAction, setDeferredAction] = useState("");
  const [deferredReason, setDeferredReason] = useState("");
  // Where a tap on the day lands: a commitment goes to its own page, a stored fact opens the sheet
  // that holds it, and everything else opens the detail sheet.
  const [engineItem, setEngineItem] = useState<DayPlanItem | null>(null);
  const [engineChip, setEngineChip] = useState<DayPlanUntimed | null>(null);
  const [engineWait, setEngineWait] = useState<DayPlanWait | null>(null);

  const bounds = useMemo(() => zonedDayBounds(dayKey, timezone), [dayKey, timezone]);
  // The free figure is the shown day's: what is left of today, or the whole of a later day. A later
  // day the engine's slots do not reach has no figure at all rather than a misleading zero.
  const capacity = useMemo(() => dayCapacityMinutes(slots, bounds.startsAt, bounds.endsAt, now), [slots, bounds, now]);
  const reachesDay = slots.some((slot) => slot.endsAt > bounds.startsAt && slot.startsAt < bounds.endsAt);
  const freeMinutes = offset === 0 ? capacity.remaining : reachesDay ? (capacity.usable ?? capacity.remaining) : null;
  const todaySessions = state.completedToday.filter(
    (item) => localDayKey(new Date(item.endedAt), timezone) === todayKey
  );
  const activeMinutes = todaySessions.reduce((sum, item) => sum + item.activeMinutes, 0);
  const dayOccurrences = state.occurrences.filter((item) => item.localDate === dayKey);
  const overlapCommitment =
    !commitmentDraft.repeats && commitmentDraft.startsAt && commitmentDraft.endsAt
      ? state.commitments.find(
          (item) =>
            item.id !== commitmentDraft.id &&
            item.status !== "cancelled" &&
            overlaps(commitmentDraft.startsAt, commitmentDraft.endsAt, item.startsAt, item.endsAt)
        )
      : undefined;
  // Rebuilt when the day, the state, or the engine result changes, and once a minute for the now-line
  // and the directive block — not on every second of the provider clock. A later day is given none of
  // the now-shaped inputs: the live directive and the ranking's next item are answers about this
  // minute, and repeating them on a day that has not started would state them as that day's. The
  // engine's projected day is passed through either way; `buildDayPlan` clips it to the day's bounds.
  const nowMinute = Math.floor(now.getTime() / 60_000);
  const isToday = offset === 0;
  const dayPlan = useMemo(
    () =>
      buildDayPlan({
        state,
        slots,
        allocations,
        recommendation: isToday ? recommendation : null,
        currentDirective: isToday ? currentDirective : null,
        upcomingDirectives: isToday ? upcomingDirectives : [],
        dayPlan: engineDayPlan,
        dayKey,
        now: new Date(nowMinute * 60_000),
        timezone
      }),
    [
      state,
      slots,
      allocations,
      recommendation,
      currentDirective,
      upcomingDirectives,
      engineDayPlan,
      dayKey,
      isToday,
      nowMinute,
      timezone
    ]
  );
  const tomorrow = useMemo(() => tomorrowBrief(state, new Date(nowMinute * 60_000)), [state, nowMinute]);
  const planStale = Boolean(state.planning?.result) && state.planning?.status !== "current";
  // Same selector Now reads, so the two pages never point at a different disruption for the same day.
  const disruption = useMemo(() => activeDisruption(state, now), [state, now]);

  const selectDayPlanItem = (item: DayPlanItem) => {
    switch (item.kind) {
      case "commitment": {
        const commitment = state.commitments.find((candidate) => candidate.id === item.entityId);
        if (!commitment) return;
        // An open-ended disruption is still under way: "Done, heading home" and "Still out" only
        // make sense while that is true, so it opens here rather than leaving for its own page.
        if (isOpenEndedDisruption(commitment)) {
          setEngineChip(null);
          setEngineItem(item);
          return;
        }
        // The commitment's own page: it holds the routine, the series and the provenance a block
        // has no room for, and carries the same editor in a sheet.
        navigateTo(`/commitments/${encodeURIComponent(commitment.id)}`);
        return;
      }
      case "sleep":
        setSheet("sleep");
        return;
      case "session":
        setSheet("sessions");
        return;
      case "active_session":
        navigateTo("/");
        return;
      case "occurrence":
        setSheet("occurrences");
        return;
      case "routine_step":
      case "directive":
      case "planned":
      case "travel":
      case "next_fit":
      case "reserved":
      case "leave_by":
      case "start_by":
      case "soft":
        setEngineChip(null);
        setEngineWait(null);
        setEngineItem(item);
        return;
    }
  };
  const selectDayPlanChip = (chip: DayPlanUntimed) => {
    setEngineItem(null);
    setEngineWait(null);
    setEngineChip(chip);
  };
  const selectDayPlanWait = (wait: DayPlanWait) => {
    setEngineItem(null);
    setEngineChip(null);
    setEngineWait(wait);
  };

  // A link that names a sheet opens it, on arrival and when the hash changes while the page is open
  // (Go to lands on `/today#direction` from Day itself).
  useEffect(() => {
    const open = () => {
      const hash = window.location.hash.slice(1);
      const target = DEEP_LINKS[hash] ?? DEEP_LINKS[new URLSearchParams(window.location.search).get("open") ?? ""];
      if (target) setSheet(target);
      const day = new URLSearchParams(window.location.search).get("day");
      if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) setLinkedDay(day);
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);

  // Seeds the two drafts once the portal is ready, and again whenever `todayKey` rolls over. Done while
  // rendering, against the key last seeded for, so a same-day poll (which changes `state.dailyPlan` but
  // not the key) leaves wins the person is still choosing alone.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const seedKey = ready ? todayKey : null;
  if (seededFor !== seedKey) {
    setSeededFor(seedKey);
    if (seedKey !== null) {
      setCommitmentDraft((current) =>
        commitmentEditorIsBlank(current) ? emptyCommitmentEditor(state.settings) : current
      );
      // Keyed on `todayKey`, not just `ready`: a page left open past midnight must drop yesterday's
      // wins before they can be saved under today's date.
      setDesiredWins(state.dailyPlan?.localDate === todayKey ? state.dailyPlan.desiredActionIds : []);
    }
  }

  async function saveDailyPlan(event: FormEvent) {
    event.preventDefault();
    try {
      await saveEntityCommand(
        dailyPlanCommand({ dayKey: todayKey, desiredActionIds: desiredWins, deferredAction, deferredReason }, state)
      );
      setDeferredAction("");
      setDeferredReason("");
      setError("");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Today's direction was not saved.");
    }
  }

  function saveCommitment(event: FormEvent) {
    event.preventDefault();
    return submitCommitment(true);
  }

  async function submitCommitment(checkForMatch: boolean) {
    // Hand entry: a new one-off that looks like something already on
    // the plan shows the notice instead of saving; **Save anyway** comes back here with the check off.
    // A failed check reads as no match, so this never blocks a save.
    if (checkForMatch) {
      const match = await findCommitmentMatch(commitmentDraft, timezone);
      setHandEntryMatch(match);
      if (match) return;
    }
    // `commitmentDraft` here is seeded only via `emptyCommitmentEditor` — this form only ever
    // creates, so there is no prior version to be stale against.
    const message = await saveCommitmentDraft(
      commitmentDraft,
      null,
      {
        state,
        saveEntityCommand,
        saveCommitmentRecurrenceRuleCommand
      },
      { newId: draftId.current() }
    );
    setError(message);
    if (message) return;
    draftId.reset();
    setHandEntryMatch(null);
    setCommitmentDraft(emptyCommitmentEditor(state.settings));
    setSheet(null);
  }

  /**
   * Ticking off preparation from the day itself: the step's own fields go back unchanged so the save
   * is a status change and nothing else, and the schedule stays the planner's to recompute.
   */
  async function markStepDone(item: DayPlanItem) {
    const command = routineStepStatusCommand(item.entityId, "completed", state);
    if (!command) throw new Error("That preparation step is no longer on the plan.");
    await saveEntityCommand(command);
  }

  // A failed save can leave focus nowhere: the submit button is disabled while it saves, so focus falls
  // to the page and Escape stops reaching the sheet. The error takes it instead, inside the sheet.
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const closeSheet = () => {
    if (sheet === "shape") {
      draftId.reset();
      setHandEntryMatch(null);
      setCommitmentDraft(emptyCommitmentEditor(state.settings));
    }
    setError("");
    setSheet(null);
    // Leave the address as the page, so a reload does not open the sheet again.
    if (window.location.hash || window.location.search) window.history.replaceState(null, "", window.location.pathname);
  };

  const time = (value: Date) => formatZonedTime(value, timezone);
  const weekday = (value: Date) =>
    dateTimeFormat(displayLocale(), { timeZone: timezone, weekday: "long" }).format(value);
  const title = dateTimeFormat(displayLocale(), {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long"
  }).format(bounds.startsAt);
  const answer = dayAnswer(dayPlan, freeMinutes, timezone);
  const plannedNights = state.sleepPlans.filter((item) => item.status === "planned");
  const activeRules = state.commitmentRecurrenceRules.filter((rule) => rule.status === "active");
  const wins = state.dailyPlan?.localDate === todayKey ? state.dailyPlan.desiredActionIds.length : 0;
  const sleepLine = tomorrow.sleep
    ? `Bed at ${time(tomorrow.sleep.startsAt)} gives you ${durationLabel(tomorrow.sleep.minutes)} before ${weekday(tomorrow.sleep.wakeAt)}'s planned ${time(tomorrow.sleep.wakeAt)} wake-up.`
    : "No sleep is planned for tonight yet.";
  const usedFraction =
    capacity.usable && capacity.usable > 0 ? (capacity.usable - capacity.remaining) / capacity.usable : null;

  const paging = (
    <>
      <IconButton label="Previous day" disabled={offset === 0} onClick={() => setOffset(offset - 1)}>
        <ChevronIcon direction="left" />
      </IconButton>
      <Button size="sm" aria-pressed={offset === 0} onClick={() => setOffset(0)}>
        Today
      </Button>
      <IconButton label="Next day" disabled={offset >= DAYS_AHEAD} onClick={() => setOffset(offset + 1)}>
        <ChevronIcon direction="right" />
      </IconButton>
    </>
  );

  // The phone's week strip: the same seven days the arrows page through, one tap each.
  const strip = (
    <div className={styles.strip} role="group" aria-label="Which day">
      {Array.from({ length: DAYS_AHEAD + 1 }, (_, index) => {
        const key = nextDayKey(todayKey, index);
        const start = zonedDayBounds(key, timezone).startsAt;
        const parts = Object.fromEntries(
          dateTimeFormat(displayLocale(), { timeZone: timezone, weekday: "short", day: "numeric" })
            .formatToParts(start)
            .map((part) => [part.type, part.value])
        );
        return (
          <button
            key={key}
            type="button"
            className={`${styles.stripDay}${index === offset ? ` ${styles.stripOn}` : ""}`}
            aria-pressed={index === offset}
            aria-label={dateTimeFormat(displayLocale(), {
              timeZone: timezone,
              weekday: "long",
              day: "numeric",
              month: "long"
            }).format(start)}
            onClick={() => setOffset(index)}
          >
            <span>{parts.weekday}</span>
            <b>{parts.day}</b>
          </button>
        );
      })}
    </div>
  );

  const summary = (
    <Card as="section" padded aria-label="Free time" className={styles.summary}>
      <div className={styles.stats}>
        <Stat
          value={freeMinutes === null ? "Not known" : durationLabel(freeMinutes)}
          label={isToday ? "free today" : "free"}
        />
        {isToday && <Stat value={durationLabel(activeMinutes)} label="recorded so far" />}
      </div>
      {isToday && usedFraction !== null && (
        <Meter value={usedFraction} label="How much of today's free time has gone" />
      )}
      {isToday && <p className={styles.small}>{sleepLine}</p>}
    </Card>
  );

  const rows = (
    <Card as="section" aria-label="Shape the day" className={styles.rows}>
      <List>
        <ListRow
          title="Direction for today"
          meta={wins ? `${plural(wins, "win")} chosen` : "Not set. Pick up to three wins to protect."}
          onClick={() => setSheet("direction")}
        />
        <ListRow
          title="Change the day"
          meta={disruption ? "Add a commitment, or see what changed" : "Add a commitment"}
          onClick={() => setSheet("shape")}
        />
        <ListRow
          title="Sleep plan"
          meta={
            tomorrow.sleep
              ? `Bed ${time(tomorrow.sleep.startsAt)} · planned wake ${time(tomorrow.sleep.wakeAt)} · ${plural(plannedNights.length, "night")} set`
              : `${plural(plannedNights.length, "night")} set`
          }
          onClick={() => setSheet("sleep")}
        />
        <ListRow
          title="Recorded today"
          meta={
            todaySessions.length
              ? `${plural(todaySessions.length, "session")} · ${durationLabel(activeMinutes)}`
              : "Nothing recorded yet"
          }
          onClick={() => setSheet("sessions")}
        />
        {dayOccurrences.length > 0 && (
          <ListRow
            title="Recurring windows"
            meta={`${plural(dayOccurrences.length, "window")} on this day`}
            onClick={() => setSheet("occurrences")}
          />
        )}
        <ListRow
          title="Recurring commitments"
          meta={activeRules.length ? `${activeRules.length} active` : "None yet"}
          href="/schedule#recurring"
        />
      </List>
    </Card>
  );

  const key = (
    <div className={styles.key}>
      <p className={styles.label}>Key</p>
      <div className={styles.badges}>
        <Badge tone="accent" dot={false}>
          Planned work
        </Badge>
        <Badge dot={false}>Fixed</Badge>
        <Badge dot={false} className={styles.travelBadge}>
          Travel
        </Badge>
      </div>
      <label className={styles.reserved}>
        <Switch checked={showReserved} onChange={setShowReserved} label="Show latest safe starts" />
        <span aria-hidden="true">Show latest safe starts</span>
      </label>
    </div>
  );

  const card = (
    <DayPlanCard
      plan={dayPlan}
      timezone={timezone}
      phone={phone}
      planStale={planStale}
      showReserved={showReserved}
      onSelect={selectDayPlanItem}
      onSelectWait={selectDayPlanWait}
      onSelectUntimed={selectDayPlanChip}
      brief={offset === 1 ? tomorrow : null}
    />
  );

  return (
    <main className={`content-page ${styles.page}`}>
      {phone ? (
        <>
          <div className={styles.phoneHead}>
            <h1 className={styles.phoneTitle}>{offset === 0 ? "Today" : weekday(bounds.startsAt)}</h1>
          </div>
          {strip}
          <p className={styles.small}>{answer}</p>
        </>
      ) : (
        <PageHeader title={title} answer={answer} actions={paging} />
      )}
      <PlaceTabs />
      {rosterLine && (
        <p className={styles.small}>
          <Link href={`/connections#${primarySourceConnection()?.id ?? ""}`}>{rosterLine}</Link>
        </p>
      )}

      <div className={styles.layout}>
        <div className={styles.primary}>{card}</div>
        <aside className={styles.side} aria-label="About this day">
          {summary}
          {rows}
          {key}
        </aside>
      </div>

      <Sheet
        open={sheet !== null}
        onClose={closeSheet}
        title={sheet ? SHEET_TITLES[sheet] : ""}
        className="today-form-sheet"
      >
        {/* Both saves on this page happen in a sheet, so the error is said where the person is looking. */}
        {error && (
          <p ref={errorRef} className="form-error" role="alert" tabIndex={-1}>
            {error}
          </p>
        )}
        {sheet === "direction" && (
          <DirectionPanel
            state={state}
            desiredWins={desiredWins}
            onDesiredWinsChange={setDesiredWins}
            deferredAction={deferredAction}
            onDeferredActionChange={setDeferredAction}
            deferredReason={deferredReason}
            onDeferredReasonChange={setDeferredReason}
            onSubmit={saveDailyPlan}
          />
        )}
        {sheet === "shape" && (
          <>
            <PlanChangePanel disruption={disruption} timezone={timezone} />
            <CommitmentEditor
              draft={commitmentDraft}
              onChange={(next) => {
                setHandEntryMatch(null);
                setCommitmentDraft(next);
              }}
              onSubmit={saveCommitment}
              handEntryMatch={handEntryMatch}
              onSaveAnyway={() => submitCommitment(false)}
              onCancel={closeSheet}
              onCreatePlaceFromSearch={(match) => createOneOffPlace(match, saveEntityCommand)}
              onCreateContact={(name) => createContact(name, state.conditionDefinitions, saveEntityCommand)}
              projects={state.projects}
              definitions={state.conditionDefinitions}
              overlapCommitment={overlapCommitment}
              timezone={timezone}
              open
            />
          </>
        )}
        {sheet === "sleep" && <SleepPlanEditor state={state} saveEntityCommand={saveEntityCommand} />}
        {sheet === "sessions" && <SessionActivityPanel sessions={todaySessions} />}
        {sheet === "occurrences" && (
          <OccurrencePanel
            occurrences={dayOccurrences}
            actions={state.actions}
            routineSteps={state.routineSteps}
            timezone={timezone}
          />
        )}
      </Sheet>
      <DayPlanDetailSheet
        item={engineItem}
        chip={engineChip}
        wait={engineWait}
        timezone={timezone}
        projects={state.projects}
        state={state}
        now={now}
        forecasts={forecasts}
        detailedEndsAt={detailedEndsAt}
        saveEntityCommand={saveEntityCommand}
        onClose={() => {
          setEngineItem(null);
          setEngineChip(null);
          setEngineWait(null);
        }}
        onMarkDone={markStepDone}
        onSnooze={snoozeAction}
      />
    </main>
  );
}
