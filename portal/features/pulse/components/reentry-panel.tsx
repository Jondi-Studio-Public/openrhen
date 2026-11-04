"use client";

import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { useEffect, useMemo, useRef, useState } from "react";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { createClientId } from "@/shared/client-id";
import { usePortal } from "@/state/portal-provider";
import { choiceLabel, type CatchUpChoice } from "@/features/catch-up/catch-up-model";
import { postReenter, ReentryRefusedError, type ReentryDone } from "../reentry-client";
import {
  EMPTY_REENTRY_DRAFT,
  ENERGY_LABELS,
  buildReenterBody,
  gapPhrase,
  itemChoices,
  progressLine,
  pruneDraft,
  reentryProgress,
  setItem,
  setProject,
  toggleContext,
  toggleDay,
  type ReentryChoices,
  type ReentryDraft,
  type ReentryEnergy,
  type ReentryReview
} from "../reentry-model";
import { useReentryReview } from "../use-reentry-review";
import styles from "./reentry-panel.module.css";

const ENERGIES = Object.keys(ENERGY_LABELS) as ReentryEnergy[];

function dayHeading(day: string): string {
  return dateTimeFormat(displayLocale(), { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(`${day}T12:00:00Z`)
  );
}

/** Done / Skipped / Dropped / Still open for one entry; none pressed until the person picks one. */
function ItemAnswer({
  entry,
  choice,
  onChoose
}: {
  entry: ReentryReview["entries"][number];
  choice: CatchUpChoice | undefined;
  onChoose: (choice: CatchUpChoice | null) => void;
}) {
  return (
    <div className={styles.exceptionItem}>
      <p className={styles.title}>{entry.title}</p>
      <div className={styles.chips} role="group" aria-label={`What happened to ${entry.title}`}>
        {itemChoices(entry).map((option) => (
          <Chip key={option} pressed={choice === option} onClick={() => onChoose(choice === option ? null : option)}>
            {option === "pending" ? "Still open" : choiceLabel(entry.kind, option)}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function FactsSection({
  choices,
  draft,
  onChange
}: {
  choices: ReentryChoices;
  draft: ReentryDraft;
  onChange: (draft: ReentryDraft) => void;
}) {
  return (
    <div className={styles.section}>
      <fieldset className={styles.group}>
        <legend className={styles.label}>Where are you?</legend>
        <div className={styles.chips}>
          {choices.places.length === 0 && <p className={styles.meta}>No saved places yet. Add one in Settings.</p>}
          {choices.places.map((place) => (
            <Chip
              key={place.id}
              pressed={draft.locationId === place.id}
              onClick={() => onChange({ ...draft, locationId: draft.locationId === place.id ? "" : place.id })}
            >
              {place.name}
            </Chip>
          ))}
        </div>
      </fieldset>
      <fieldset className={styles.group}>
        <legend className={styles.label}>Energy</legend>
        <div className={styles.chips}>
          {ENERGIES.map((energy) => (
            <Chip
              key={energy}
              pressed={draft.energy === energy}
              onClick={() => onChange({ ...draft, energy: draft.energy === energy ? "" : energy })}
            >
              {ENERGY_LABELS[energy]}
            </Chip>
          ))}
        </div>
      </fieldset>
      <fieldset className={styles.group}>
        <legend className={styles.label}>What do you have available?</legend>
        <div className={styles.chips}>
          {choices.contexts.map((context) => (
            <Chip
              key={context.id}
              pressed={draft.contexts?.includes(context.id) ?? false}
              onClick={() => onChange(toggleContext(draft, context.id))}
            >
              {context.name}
            </Chip>
          ))}
          <Chip
            pressed={draft.contexts !== null && draft.contexts.length === 0}
            onClick={() => onChange({ ...draft, contexts: draft.contexts?.length === 0 ? null : [] })}
          >
            None of these
          </Chip>
        </div>
      </fieldset>
    </div>
  );
}

/** Tier "today": every planned thing in the window, item by item. */
function TodayReview({
  review,
  draft,
  onChange
}: {
  review: ReentryReview;
  draft: ReentryDraft;
  onChange: (draft: ReentryDraft) => void;
}) {
  if (review.entries.length === 0) return null;
  return (
    <div className={styles.section}>
      <h3 className={styles.heading}>What happened to these?</h3>
      <Card className={styles.rows}>
        {review.entries.map((entry) => (
          <div key={entry.id} className={styles.row}>
            <ItemAnswer
              entry={entry}
              choice={draft.items[entry.id]}
              onChoose={(choice) => onChange(setItem(draft, entry.id, choice))}
            />
          </div>
        ))}
      </Card>
    </div>
  );
}

/** Tier "days": one tap per day, with the day's items behind a disclosure for exceptions. An external date is always asked. */
function DaysReview({
  review,
  draft,
  onChange
}: {
  review: ReentryReview;
  draft: ReentryDraft;
  onChange: (draft: ReentryDraft) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const byId = useMemo(() => new Map(review.entries.map((entry) => [entry.id, entry])), [review.entries]);
  if (review.days.length === 0) return null;
  return (
    <div className={styles.section}>
      <h3 className={styles.heading}>Anything you did on these days?</h3>
      <p className={styles.meta}>Tap a day if nothing was recorded. Open it to mark something you did.</p>
      <Card className={styles.rows}>
        {review.days.map((group) => {
          const entries = group.entryIds.flatMap((id) => byId.get(id) ?? []);
          const external = entries.filter((entry) => entry.kind === "external_deadline");
          const expanded = open[group.day] ?? false;
          const tapped = draft.days[group.day] === true;
          return (
            <div key={group.day} className={styles.row}>
              <div className={styles.rowHead}>
                <div>
                  <p className={styles.title}>{dayHeading(group.day)}</p>
                  <p className={styles.meta}>
                    {entries.length} {entries.length === 1 ? "thing" : "things"}
                  </p>
                </div>
                <div className={styles.chips}>
                  <Chip pressed={tapped} onClick={() => onChange(toggleDay(draft, group.day))}>
                    Nothing recorded
                  </Chip>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={expanded}
                    onClick={() => setOpen({ ...open, [group.day]: !expanded })}
                  >
                    {expanded ? "Hide" : "Exceptions"}
                  </Button>
                </div>
              </div>
              {external.length > 0 && !expanded && (
                <p className={styles.meta}>
                  {external.length === 1
                    ? "A date set by someone else needs its own answer"
                    : "Dates set by others need their own answers"}
                  : open the day.
                </p>
              )}
              {expanded && (
                <div className={styles.exceptions}>
                  {entries.map((entry) => (
                    <ItemAnswer
                      key={entry.id}
                      entry={entry}
                      choice={draft.items[entry.id]}
                      onChoose={(choice) => onChange(setItem(draft, entry.id, choice))}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}

/** Tier "projects": keep open or drop all per project, or start fresh. External dates still need their own answers. */
function ProjectsReview({
  review,
  draft,
  onChange
}: {
  review: ReentryReview;
  draft: ReentryDraft;
  onChange: (draft: ReentryDraft) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const byId = useMemo(() => new Map(review.entries.map((entry) => [entry.id, entry])), [review.entries]);
  return (
    <div className={styles.section}>
      <h3 className={styles.heading}>Which projects are still alive?</h3>
      <p className={styles.meta}>
        Keep a project&apos;s old items open, or drop them all. Or start fresh and let everything old lapse.
      </p>
      <div className={styles.chips}>
        <Chip pressed={draft.startFresh} onClick={() => onChange({ ...draft, startFresh: !draft.startFresh })}>
          Start fresh
        </Chip>
      </div>
      <Card className={styles.rows}>
        {review.projects.map((group) => {
          const key = group.projectId ?? "";
          const entries = group.entryIds.flatMap((id) => byId.get(id) ?? []);
          const external = entries.filter((entry) => entry.kind === "external_deadline");
          const answer = group.projectId ? draft.projects[group.projectId] : undefined;
          return (
            <div key={key || "none"} className={styles.row}>
              <div className={styles.rowHead}>
                <div>
                  <p className={styles.title}>{group.title ?? "No project"}</p>
                  <p className={styles.meta}>
                    {entries.length} old {entries.length === 1 ? "item" : "items"}
                  </p>
                </div>
                <div className={styles.chips}>
                  {group.projectId && (
                    <>
                      <Chip
                        pressed={answer === "keep_open"}
                        onClick={() =>
                          onChange(setProject(draft, group.projectId!, answer === "keep_open" ? null : "keep_open"))
                        }
                      >
                        Keep open
                      </Chip>
                      <Chip
                        pressed={answer === "drop_all"}
                        onClick={() =>
                          onChange(setProject(draft, group.projectId!, answer === "drop_all" ? null : "drop_all"))
                        }
                      >
                        Drop all
                      </Chip>
                    </>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={open[key] ?? false}
                    onClick={() => setOpen({ ...open, [key]: !(open[key] ?? false) })}
                  >
                    {open[key] ? "Hide" : "Items"}
                  </Button>
                </div>
              </div>
              {external.length > 0 && !open[key] && (
                <p className={styles.meta}>A date set by someone else needs its own answer: open the items.</p>
              )}
              {open[key] && (
                <div className={styles.exceptions}>
                  {entries.map((entry) => (
                    <ItemAnswer
                      key={entry.id}
                      entry={entry}
                      choice={draft.items[entry.id]}
                      onChoose={(choice) => onChange(setItem(draft, entry.id, choice))}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}

/**
 * The re-entry sheet (the pulse on plan design note, sections 4 and 5). While the pulse is off/lapsed it stands in
 * for the directive on Now: where you are, your energy and what you have, then the review of the gap at the size the
 * gap calls for (today item by item, days one tap each, projects keep or drop). Submit stays off until the server would
 * accept it; a refusal it still gives (the window moved) shows its missing lines in place. Success hands the returned
 * state to the provider and tells Now what to undo.
 */
export function ReentryPanel({ onDone }: { onDone: (done: ReentryDone) => void }) {
  const { state, acceptServerState } = usePortal();
  const timezone = state.settings.timezone;
  const { load, reload } = useReentryReview(true);
  const [draft, setDraft] = useState<ReentryDraft>(EMPTY_REENTRY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  // One id per attempt, kept across a retry of the same answers so a lost response replays; a change makes a new one.
  const commandId = useRef(createClientId());

  useEffect(() => {
    if (load.status !== "ready") return;
    // oxlint-disable-next-line react/set-state-in-effect -- reconciles saved answers with the entries a fresh read lists
    setDraft((current) => pruneDraft(current, load.review));
  }, [load]);

  const change = (next: ReentryDraft) => {
    commandId.current = createClientId();
    setDraft(next);
    setError("");
    setMissing([]);
  };

  if (load.status === "loading")
    return (
      <Card padded aria-busy="true">
        <p className={styles.lead}>Looking at what you missed…</p>
      </Card>
    );
  if (load.status === "error")
    return (
      <Banner
        tone="danger"
        action={
          <Button size="sm" variant="secondary" onClick={reload}>
            Try again
          </Button>
        }
      >
        {load.message}
      </Banner>
    );
  if (load.status === "healed")
    return (
      <Banner
        tone="info"
        action={
          <Button size="sm" onClick={reload}>
            Check again
          </Button>
        }
      >
        Already back on plan. Refresh to carry on.
      </Banner>
    );

  const { review, choices } = load;
  const progress = reentryProgress(review, draft, timezone);

  async function submit() {
    if (busy || !progress.complete) return;
    setBusy(true);
    setError("");
    setMissing([]);
    try {
      const done = await postReenter(buildReenterBody(review, draft, commandId.current));
      if (done.state) acceptServerState(done.state);
      onDone(done);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The re-entry was not saved.");
      if (failure instanceof ReentryRefusedError) {
        setMissing(failure.missing);
        reload();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card as="section" padded aria-label="Back on plan" className={styles.panel}>
      <div className={styles.section}>
        <h2 className={styles.heading}>Welcome back. Let&apos;s get you back on plan.</h2>
        <p className={styles.lead}>
          {review.lastConfirmedAt
            ? `The plan lost track of you ${gapPhrase(review.gapMinutes)} ago.`
            : "The plan has not heard from you in a while."}{" "}
          Tell it where you are, then settle what was missed.
        </p>
      </div>
      <FactsSection choices={choices} draft={draft} onChange={change} />
      {review.tier === "today" && <TodayReview review={review} draft={draft} onChange={change} />}
      {review.tier === "days" && <DaysReview review={review} draft={draft} onChange={change} />}
      {review.tier === "projects" && <ProjectsReview review={review} draft={draft} onChange={change} />}
      {review.lapsing > 0 && (
        <p className={styles.meta}>
          {review.lapsing} repeating {review.lapsing === 1 ? "occurrence lapses" : "occurrences lapse"} as missed
          without asking.
        </p>
      )}
      {review.tier !== "none" && review.entries.length > 0 && (
        <label className={styles.group}>
          <span className={styles.label}>What happened instead (optional)</span>
          <textarea
            className={styles.note}
            rows={2}
            maxLength={2000}
            value={draft.note}
            onChange={(event) => change({ ...draft, note: event.target.value })}
          />
        </label>
      )}
      {error && (
        <Banner tone="danger">
          {error}
          {missing.length > 0 && (
            <ul className={styles.missing}>
              {missing.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </Banner>
      )}
      <div className={styles.bar}>
        <p className={styles.progress} aria-live="polite">
          {progressLine(progress)}
        </p>
        <Button variant="primary" size="lg" disabled={busy || !progress.complete} onClick={() => void submit()}>
          {busy ? "Saving…" : "Back on plan"}
        </Button>
      </div>
    </Card>
  );
}
