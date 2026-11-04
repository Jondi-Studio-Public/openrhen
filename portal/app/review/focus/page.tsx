"use client";

import { PlaceTabs } from "@/components/place-tabs";
import { useState } from "react";
import { useNow } from "@/shared/clock";
import { usePortal } from "@/state/portal-provider";
import { focusableProjects, focusSelection, periodFor, periodLabel } from "@/features/review/planning-focus-period";
import { saveFocusCommand } from "@/features/review/review-commands";
import { addDays } from "@/features/review/review-progress";

/**
 * `/review/focus`: the full two-period checkbox editor for undated project focus, split off the
 * compact `/review` overview so that overview stays a dashboard rather than a form. `/review` links
 * here and shows only the resulting selection count and effort total against available capacity.
 */
export default function ReviewFocusPage() {
  const { state, ready, capacityEnvelopes, saveEntityCommand } = usePortal();
  const now = useNow("minute");
  const weeklyPeriod = periodFor("weekly", now, state.settings.timezone);
  const monthlyPeriod = periodFor("monthly", now, state.settings.timezone);
  const weeklyRecord = state.planningFocus.find(
    (item) => item.kind === "weekly" && item.periodStart === weeklyPeriod.start
  );
  const monthlyRecord = state.planningFocus.find(
    (item) => item.kind === "monthly" && item.periodStart === monthlyPeriod.start
  );
  // With nothing saved for this week yet, the boxes start from last week's focus (saved only when Save is pressed).
  const lastWeekRecord = state.planningFocus.find(
    (item) => item.kind === "weekly" && item.periodStart === addDays(weeklyPeriod.start, -7)
  );
  const prefilled = !weeklyRecord && focusSelection(lastWeekRecord?.projectIds ?? [], state.projects).length > 0;
  const [weekly, setWeekly] = useState<string[]>([]);
  const [monthly, setMonthly] = useState<string[]>([]);
  const [focusMessage, setFocusMessage] = useState("");
  // Each selection reseeds from its stored record whenever that record (or its version) changes, and
  // once on the first render; rendering the same record again leaves a half-made selection alone.
  // The key names the record the boxes come from, last week's included, and whether the plan has loaded: on a
  // cold load the records and projects arrive after the first render, and the seed must run again then.
  const weeklyKey = `${weeklyRecord?.id ?? (lastWeekRecord ? `last:${lastWeekRecord.id}` : "")}|${weeklyRecord?.version ?? ""}|${ready}`;
  const monthlyKey = `${monthlyRecord?.id ?? ""}|${monthlyRecord?.version ?? ""}`;
  const [seededWeeklyKey, setSeededWeeklyKey] = useState<string | null>(null);
  const [seededMonthlyKey, setSeededMonthlyKey] = useState<string | null>(null);
  if (seededWeeklyKey !== weeklyKey) {
    setSeededWeeklyKey(weeklyKey);
    setWeekly(focusSelection((weeklyRecord ?? lastWeekRecord)?.projectIds ?? [], state.projects));
  }
  if (seededMonthlyKey !== monthlyKey) {
    setSeededMonthlyKey(monthlyKey);
    setMonthly(focusSelection(monthlyRecord?.projectIds ?? [], state.projects));
  }

  if (!ready)
    return (
      <main className="content-page">
        <p>Loading review…</p>
      </main>
    );

  const undated = focusableProjects(state.projects);
  const available = capacityEnvelopes.reduce((sum, band) => sum + band.adjustedCapacityMinutes, 0);
  const selected = [...new Set([...weekly, ...monthly])];
  const selectedEffort = selected.reduce((sum, id) => {
    const project = state.projects.find((item) => item.id === id);
    return (
      sum +
      (project?.remainingEffortOverrideMinutes ??
        state.actions
          .filter((action) => action.projectId === id && !["done", "cancelled", "archived"].includes(action.status))
          .reduce((value, action) => value + action.remainingMinutes, 0))
    );
  }, 0);

  async function saveFocus(kind: "weekly" | "monthly", projectIds: string[]) {
    const period = kind === "weekly" ? weeklyPeriod : monthlyPeriod;
    const record = kind === "weekly" ? weeklyRecord : monthlyRecord;
    try {
      const command = saveFocusCommand(kind, period, record, projectIds);
      await saveEntityCommand(command);
      setFocusMessage(`${kind === "weekly" ? "Weekly" : "Monthly"} focus saved.`);
    } catch (error) {
      setFocusMessage(error instanceof Error ? error.message : "Focus was not saved.");
    }
  }

  return (
    <main className="content-page review-page">
      <a className="back-link" href="/review">
        ← Review
      </a>
      <p className="eyebrow">Review</p>
      <h1>Undated project focus</h1>
      <p className="reason">
        Deadline projects forecast automatically. Undated work receives capacity only for the dated Review periods
        selected here.
      </p>
      <PlaceTabs />
      <p className="microcopy">{selected.length} selected across both periods.</p>
      {prefilled && !focusMessage && (
        <p className="microcopy">This week starts from last week&apos;s focus. Save it to keep it.</p>
      )}
      {focusMessage && (
        <p className="microcopy" role="status">
          {focusMessage}
        </p>
      )}
      {selectedEffort > available && (
        <p className="form-warning">
          The selected focus set needs about {Math.round(selectedEffort / 60)} hours, more than the{" "}
          {Math.round(available / 60)} discounted hours available in this forecast.
        </p>
      )}
      <div className="focus-grid">
        <FocusPeriod
          title="This week"
          dates={periodLabel("weekly", weeklyPeriod)}
          projects={undated}
          selected={weekly}
          setSelected={setWeekly}
          save={() => saveFocus("weekly", weekly)}
        />
        <FocusPeriod
          title="This month"
          dates={periodLabel("monthly", monthlyPeriod)}
          projects={undated}
          selected={monthly}
          setSelected={setMonthly}
          save={() => saveFocus("monthly", monthly)}
        />
      </div>
    </main>
  );
}

function FocusPeriod({
  title,
  dates,
  projects,
  selected,
  setSelected,
  save
}: {
  title: string;
  dates: string;
  projects: Array<{ id: string; title: string }>;
  selected: string[];
  setSelected: (value: string[]) => void;
  save: () => void;
}) {
  return (
    <details className="editor-card" open>
      <summary>{title}</summary>
      <div className="focus-card">
        <p className="microcopy">{dates}</p>
        <div className="choice-list">
          {projects.map((project) => (
            <label key={project.id}>
              <input
                type="checkbox"
                checked={selected.includes(project.id)}
                onChange={(event) =>
                  setSelected(
                    event.target.checked ? [...selected, project.id] : selected.filter((id) => id !== project.id)
                  )
                }
              />
              <span>{project.title}</span>
            </label>
          ))}
          {!projects.length && <p className="empty">No active undated projects.</p>}
        </div>
        <button className="small" onClick={save}>
          Save {title.toLowerCase()} focus
        </button>
      </div>
    </details>
  );
}
